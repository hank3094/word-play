#!/usr/bin/env python
"""Generate answers_{N}.txt and allowed_{N}.txt from a plain Scrabble word list.

Words above --threshold (by wordfreq English frequency) go into the answers file; all
valid N-letter words go into the allowed file.  Run with:

    uv run --with wordfreq scripts/generate_wordlists.py \\
        --input /path/to/collins.txt --length 4 --output-dir games/words/

wordfreq is NOT a project runtime dependency — the --with flag installs it just for
this invocation.  Any plain word list works as input (Collins, TWL, SOWPODS, etc.),
one word per line.
"""

import argparse
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--input", required=True, help="Source word list (.txt, one word per line)")
    parser.add_argument(
        "--length",
        type=int,
        choices=[4, 5, 6, 7],
        required=True,
        help="Target word length",
    )
    parser.add_argument(
        "--output-dir",
        default="games/words",
        help="Directory for output files (default: games/words)",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=3e-6,
        help=(
            "Minimum wordfreq English frequency to qualify as an answer (default: 3e-6). "
            "Use --threshold 0 to count total words before filtering, then raise until the "
            "answers list is roughly 1000-2000 words."
        ),
    )
    args = parser.parse_args()

    try:
        from wordfreq import word_frequency
    except ImportError:
        parser.error(
            "wordfreq is not installed. Run via:\n"
            "  uv run --with wordfreq scripts/generate_wordlists.py ..."
        )

    src = Path(args.input)
    if not src.exists():
        parser.error(f"Input file not found: {src}")

    n = args.length
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Filter source to exactly N-letter alphabetic words.
    # Supports both plain lists (one word per line) and definition-format files like CSW
    # where the word is the first whitespace-separated token on each line.
    raw: set[str] = set()
    for line in src.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        w = line.split()[0].lower()
        if len(w) == n and w.isalpha():
            raw.add(w)

    print(f"Found {len(raw):,} {n}-letter words in source file.")

    if not raw:
        print("No words matched — check that the input file contains the right word length.")
        return

    # Score each word and split into answers / allowed.
    scored = sorted(
        ((w, word_frequency(w, "en")) for w in raw),
        key=lambda x: (-x[1], x[0]),
    )

    answers = [w for w, freq in scored if freq >= args.threshold]
    allowed = sorted(raw)

    answers_path = out_dir / f"answers_{n}.txt"
    allowed_path = out_dir / f"allowed_{n}.txt"

    answers_path.write_text("\n".join(answers) + "\n")
    allowed_path.write_text("\n".join(allowed) + "\n")

    print(f"answers_{n}.txt : {len(answers):>5,} words  (threshold={args.threshold:.1e})")
    print(f"allowed_{n}.txt : {len(allowed):>5,} words")
    print(f"Written to {out_dir.resolve()}/")

    if len(answers) == 0:
        print("\n  Tip: threshold is too high — try --threshold 0 to see total words available.")
    elif len(answers) < 500:
        print(f"\n  Tip: only {len(answers)} answers — lower --threshold to get more.")
    elif len(answers) > 3000:
        print(f"\n  Tip: {len(answers)} answers is a lot — raise --threshold to ~1e-5 or higher.")


if __name__ == "__main__":
    main()
