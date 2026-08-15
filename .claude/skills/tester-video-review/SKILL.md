---
description: Review a tester's screen-recording video for app issues and file the confirmed ones as board tasks. Use whenever someone hands over an mp4/mov from a device tester ("here is a video from an iOS tester", "analyse this recording", "what bugs are in this clip"). It exists because the naive approach (seek, skim, file) produces confidently wrong timestamps and false-positive bugs that are really loading states.
allowed-tools: Read, Glob, Grep, Write, PowerShell(ffmpeg:*), PowerShell(ffprobe:*), PowerShell(winget:*), PowerShell(Get-ChildItem:*), PowerShell(Get-Item:*), PowerShell(New-Item:*), PowerShell(Remove-Item:*)
argument-hint: [path to the video, plus any notes the tester gave]
---

# Tester Video Review

Turn a tester's screen recording into a short list of verified defects, then into board tasks.

You cannot watch a video. You extract frames and read them as images. Everything below exists
because some step of that pipeline lies to you in a way that looks like a finding.

## 0. Tooling

`ffmpeg` and `ffprobe` are the whole toolchain. If `Get-Command ffmpeg` fails, install once with
`winget install --id Gyan.FFmpeg --exact --silent --accept-source-agreements --accept-package-agreements`,
then invoke through `$env:LOCALAPPDATA\Microsoft\WinGet\Links\ffmpeg.exe` for the rest of the
session (the PATH alias will not exist in an already-running shell).

Version note: **ffmpeg 9.0 removed `-vsync`.** Use `-fps_mode passthrough`. A skill that still
passes `-vsync` fails with `Unrecognized option`.

Write every frame to the session scratchpad, never into the repo.

## 1. Probe before you extract

One `ffprobe` call answers three planning questions:

```
ffprobe -v error -show_entries "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate" -of default <video>
```

- **Resolution** tells you whether text will be legible. A clean screen recording is fine. A
  phone filmed with another phone (glare, skew, small text) is not, and you should say so early
  rather than grinding out low-confidence findings.
- **Is there an audio stream?** Testers narrate ("watch, I tap this and nothing happens"), and
  that narration is usually where the issue *descriptions* live while the pixels only show
  symptoms. Do not silently produce a visual-only report.
- **Frame rate**, which step 2 depends on.

Then check whether the audio is actually speech, in one call:

```
ffmpeg -v info -i <video> -af volumedetect -vn -f null NUL
```

`mean_volume` near `-91 dB` is digital silence: nothing is being lost, say so and move on. Any
real level means narration probably exists. There is no local speech-to-text on this machine and
installing one is a heavy lift, so **tell the user the track has audio, that you are reading
pixels only, and let them summarise it** (thirty seconds for them, much cheaper than a Whisper
install). Never report a visual-only pass as a complete pass when a live audio track exists.

## 2. Extract frames, and get the timestamps right

Timestamps are the deliverable. Every finding you file needs a "at 0:47" citation or nobody can
verify it.

- **Never use `-ss` before `-i`.** That is a keyframe seek and it silently lands on a different
  frame than you asked for. It will make you cite the wrong moment and can invent a finding
  outright. Use output seeking (`-i <video> -ss <start> -t <len>`) or a time-gated `select`.
- **Confirm the frame rate is constant before mapping frame index to time.** `r_frame_rate` is
  nominal. Verify with `-count_frames`: `nb_read_frames` divided by `duration` should equal it.
  Under variable frame rate (common for phone captures) frame-index arithmetic is meaningless,
  so use the time-based `fps` filter instead.

Uniform sweep at 2s, for a video of a couple of minutes:

```
ffmpeg -y -v error -i <video> -vf "fps=0.5" -fps_mode passthrough <scratch>\t_%03d.png
```

Frame `t_00k` is at `t = (k - 1) * 2` seconds. Sanity-check that mapping against one known
moment before you trust it across the whole timeline.

**Do not build contact sheets.** Images are downscaled to ~1568px on the long edge before you
read them, so tiling phone frames destroys exactly the small text you need. Read frames
individually. A 444x960 frame costs only a few hundred tokens, so a two-minute sweep is cheap.

## 3. Triage, then verify before filing

Read the sweep in order and build a timeline of what screen is on-screen when. Note anything
that looks wrong.

**Start from the reporter's claims when you have them.** Whatever the tester or the user said
("the tab icon is showing as text", "I had to open the menu twice") is the triage spine: the
video's job is to confirm and root-cause those, not to generate a list from scratch. Two
consequences. Treat their hedges as hedges: "this may also be affected" is a candidate to raise
as a question, not an assertion to file. And sweep the rest of the timeline anyway for what
they did not notice, since a tester reports what annoyed them, not what is worst.

Then, the rule that matters most:

> **Re-verify every candidate finding at 1s granularity before filing it.**

A blank pane, an empty list, a missing spinner, a stale value: at a 2s sample these are
indistinguishable from a defect, and they are usually a **transient loading state**. Extract
1fps across the suspect window with accurate output seeking and confirm the state persists. In
practice this kills roughly one candidate in five. A false bug filed against a working feature
costs more than a missed one.

Findings the sweep genuinely supports get a timestamp and a frame path. Findings it does not
get dropped, out loud.

## 4. Ground each finding in source

A task that names the symptom is worth little; one that names the file and line is worth a lot.
`Grep` the screen or component behind each finding and read enough to state a cause. Then
separate the two confidence levels explicitly when you write it up:

- **Symptom**: fact, with timestamps and frames. Assert it.
- **Cause**: hypothesis until reproduced. Label it as such.

Look for a link between findings before filing them as separate bugs. Two symptoms with one
root cause should be one task, and a second symptom that is probably *consequent* should be
noted inside that task as "re-test after the fix", not filed as its own investigation.

The technique that finds those links: once you have a cause in one file, `Grep` its **sibling
files and the layout or container that owns them** for the same pattern. A shared invariant is
usually written down somewhere near the top of the tree. Two sheets rendering wrong at opposite
edges turned out to be one constraint declared in the router layout, and every sibling sheet
carried it. Filing per-screen would have bought a local patch per screen and fixed none of the
cause, and would have missed the two siblings the tester never opened. Widen the task to the
audit surface and name the screens the video did not exercise.

## 5. Cross-reference, propose, then file

1. `kangentic_search_tasks` for each finding before filing. A duplicate of a known-open item is
   worse than nothing.
2. **Show the user the proposed list and wait.** A real video yields genuine bugs, tester
   confusion that is not a bug, and duplicates. That triage is the user's call, not yours,
   especially for anything the tester themselves hedged.
3. File the confirmed ones with `kangentic_create_task`. Attach the source video and any
   supporting frames via `attachments`.

MCP gotcha: when a `create_task` call carries both a long description and `labels`, the labels
can be dropped. Create the task first, then set labels in a separate labels-only
`kangentic_update_task` call.

## Report

Give the user a timeline, the confirmed findings with timestamps and root causes, what you
dropped after verification and why, and the tasks created. Name anything the video could not
settle rather than rounding it to a conclusion.
