**English** · [Русский](README.ru.md)

# Local Transcribe — local speech-to-text with speakers for BB

A fully **local** pipeline: speech → Russian text plus "who speaks when"
(speaker diarization). No cloud and no HuggingFace tokens. Every run is a
one-shot process: load the models, work, exit, and the OS frees the memory.
It ships as a BB plugin, so agents of every project and machine can transcribe
recordings and meetings.

## How it works

```
audio/video ──ffmpeg──► wav 16k mono
                         │
            ┌────────────┴─────────────┐
            ▼                          ▼
   TEXT (ASR)                  SPEAKERS (diarization)
   GigaAM v3 (CTC, GGUF)       ModelScope 3D-Speaker:
                                 FSMN VAD → CAM++ embeddings → clustering
            │                          │
            └──────── merged by timestamps ────────►  Speaker N [mm:ss]: text
```

- **Text**: GigaAM v3 (end-to-end CTC), the best quality for Russian; other
  engines only when the user picks them.
- **Speakers**: ModelScope `iic/speech_campplus_speaker-diarization_common`
  (PyTorch, on the Mac GPU via MPS).
- About 4 minutes for a 40-minute recording on an Apple Silicon Mac.

## In BB

`bb-plugin/` is the BB plugin with the `local-transcribe` skill. The agent of
the thread gets the recording (a link, an attachment or a path), the plugin runs
recognition on a Mac with a GPU first, then on ready fallback machines by the
call's policy, and returns the results to the requesting machine. The agent then
writes summaries, decisions, tasks and a PDF from the project context. The ASR
service itself never names people or assigns tasks.

- Tools for agents: `local_transcribe_services`, `local_transcribe_submit`,
  `local_transcribe_status`, `local_transcribe_copy`, `local_transcribe_cancel`;
  the same as discoverable RPC `local-transcribe` for other plugins.
- Results on request: transcript, diarization JSON (speaker intervals and
  timestamped lines), AAC audio, a copy of the source; each with size and SHA-256.
- A job with a thread id wakes that thread once with the result or error.
- Survives a sleeping Mac and retries delivery: [docs/reliability.md](docs/reliability.md);
  known speaker count, cache and voice samples: [docs/diarization.md](docs/diarization.md).

## Install and update

```sh
bb plugin install 'git:https://github.com/ainurminibaev/local-transcribe.git@semver:^0.2.0' --yes
```

The Python engine is part of the plugin's host package: after one update in BB
(`bb plugin update local-transcribe`) the code reaches every registered executor
on first use, and environments are prepared automatically. Running jobs keep
their version; models and results are kept. Executors are set in the `workerHosts`
setting and need Python 3.10+ and ffmpeg. The plugin is part of the
[bb-config](https://github.com/ainurminibaev/bb-config) set. Release procedure:
[docs/updates.md](docs/updates.md).

## Command line

```bash
# with speakers (default)
python3 diarize_ms.py "<file>" --out "<folder>/transcript.txt"
# text only (fast, about 70 s)
python3 transcribe.py "<file>" --out "<folder>/transcript.txt"
```

Output with speakers: `Speaker N [mm:ss]: text`. Model paths, engines and the
one-time dependencies are described in [README.ru.md](README.ru.md) (Russian).

## Checks

`python3 scripts/sync_runtime.py --check`, `python3 scripts/sync_release.py --check`
and the `test_*.py` suites.
