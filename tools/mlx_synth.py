#!/usr/bin/env python3
"""One-shot MLX CosyVoice3 synthesis helper for dsh-line-bot.

Reads a JSON job file, synthesizes one WAV, and prints a single
`RESULT:{...}` line on stdout so the Node side can parse it.
"""
import glob
import json
import os
import sys
import traceback


def emit(payload):
    sys.stdout.write("RESULT:" + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        emit({"ok": False, "error": "missing job file"})
        return 2
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        job = json.load(handle)

    prefix = job.get("prefix") or "tts"
    os.makedirs(os.path.dirname(prefix) or ".", exist_ok=True)

    try:
        from mlx_audio.tts.generate import generate_audio

        kwargs = {
            "text": job["text"],
            "model": job.get("model") or "mlx-community/Fun-CosyVoice3-0.5B-2512-8bit",
            "ref_audio": job.get("refAudio"),
            "file_prefix": prefix,
            "audio_format": "wav",
            "verbose": False,
            "join_audio": True,
        }
        if job.get("instructText"):
            kwargs["instruct_text"] = job["instructText"]
        elif job.get("refText"):
            kwargs["ref_text"] = job["refText"]
        generate_audio(**kwargs)

        candidates = sorted(glob.glob(prefix + "*.wav"), key=os.path.getmtime)
        if not candidates:
            emit({"ok": False, "error": "no output wav produced"})
            return 1
        emit({"ok": True, "file": candidates[-1]})
        return 0
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        emit({"ok": False, "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
