#!/usr/bin/env python
"""Score every hangman candidate word by how hard it is to guess letter-by-letter, then bin
words into easy/medium/hard/nightmare by that score (replacing the old frequency-only tiers).

Full methodology -- the solver, why the score is "surprisal"/cross-entropy rather than entropy
itself, the precedent/alternatives considered, the corpus, and exactly how the commonness floors
per bin were chosen -- is written up in docs/hangman-difficulty.md. Short version: at each step
the solver guesses whichever unguessed letter is present in the largest fraction `p` of words
still consistent with what's been revealed/ruled out so far. The cost of that guess is -log2(p) if
the letter turns out to be present, or -log2(1-p) if absent, summed across every step (no 6-guess
cap -- this measures the word's inherent difficulty, independent of the live game's guess limit)
to get the word's difficulty_score. Bins are then gated by a one-sided commonness floor per tier
(see COMMONNESS_FLOOR below) so e.g. "easy" can't contain a word nobody's ever heard of.

Also records "commonness" (wordfreq's English zipf frequency, the same metric the old tiers used)
so both can be compared/saved together.

Run with:

    uv run --with numpy --with wordfreq scripts/compute_hangman_difficulty.py \\
        --input data/CSW21.txt

numpy and wordfreq are NOT project runtime dependencies -- the --with flags install them just for
this invocation, matching the convention used by the other scripts/generate_*.py scripts.
"""

import argparse
import csv
import math
import time
from pathlib import Path

MIN_LENGTH = 3
MAX_LENGTH = 15
LETTERS = [chr(ord("a") + i) for i in range(26)]


def load_words(path: Path) -> set[str]:
    """Same CSW21 parsing as scripts/generate_wordlists.py and the now-superseded
    generate_hangman_words.py: the word is the first whitespace-separated token on each line,
    `#`-prefixed lines are comments."""
    words: set[str] = set()
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        w = line.split()[0].lower()
        if MIN_LENGTH <= len(w) <= MAX_LENGTH and w.isalpha():
            words.add(w)
    return words


def solve_word(word, arr, presence, letter_rank):
    """Simulate the frequency solver against one word. Returns (difficulty_score, num_steps,
    num_wrong). `arr` is the (N, L) uint8 char-code array and `presence` the (N, 26) boolean
    presence matrix for this word's length bucket; both cover every candidate of that length."""
    import numpy as np

    n_total, length = arr.shape
    target = set(word)
    guessed: set[str] = set()
    mask = np.ones(n_total, dtype=bool)
    score = 0.0
    steps = 0
    wrong = 0

    while not target <= guessed:
        n_cand = int(mask.sum())
        counts = presence[mask].sum(axis=0)
        avail = [k for k in range(26) if LETTERS[k] not in guessed]
        # Most candidates containing the letter wins; ties broken by overall corpus frequency.
        best_k = max(avail, key=lambda k: (counts[k], letter_rank[k]))
        letter = LETTERS[best_k]
        p = counts[best_k] / n_cand
        guessed.add(letter)
        steps += 1

        if letter in target:
            score += -math.log2(max(p, 1e-12))
            # Real hangman reveals every occurrence of a guessed letter, so a candidate must
            # match the secret word's exact positions for this letter, not just "at least these."
            letter_ord = ord(letter)
            positions = {i for i, c in enumerate(word) if c == letter}
            match = np.ones(n_total, dtype=bool)
            for i in range(length):
                col = arr[:, i] == letter_ord
                match &= col if i in positions else ~col
            mask &= match
        else:
            wrong += 1
            score += -math.log2(max(1 - p, 1e-12))
            mask &= ~presence[:, best_k]

    return score, steps, wrong


def process_length_bucket(length, words, zipf_frequency):
    import numpy as np

    words = sorted(words)
    arr = np.array([[ord(c) for c in w] for w in words], dtype=np.uint8)
    presence = np.zeros((len(words), 26), dtype=bool)
    for k, letter in enumerate(LETTERS):
        presence[:, k] = (arr == ord(letter)).any(axis=1)
    letter_rank = presence.sum(axis=0)  # corpus-wide frequency, for deterministic tie-breaks

    rows = []
    for word in words:
        score, steps, wrong = solve_word(word, arr, presence, letter_rank)
        rows.append(
            {
                "word": word,
                "length": length,
                "commonness": round(zipf_frequency(word, "en"), 4),
                "difficulty_score": round(score, 4),
                "num_steps": steps,
                "num_wrong": wrong,
            }
        )
    return rows


# Bins, easiest first. Each has a *minimum* commonness it requires -- a one-sided floor, not a
# range: "easy" must be a genuinely common word; looser tiers tolerate progressively rarer words,
# down to "nightmare" which has no floor at all (a nightmare word can be common or totally
# obscure -- only its solver-difficulty matters there).
BIN_ORDER = ["easy", "medium", "hard", "nightmare"]
COMMONNESS_FLOOR = {"easy": 4.0, "medium": 2.5, "hard": 1.0, "nightmare": 0.0}


def assign_bins(rows):
    import numpy as np

    scores = np.array([r["difficulty_score"] for r in rows])
    p50, p80, p95 = np.percentile(scores, [50, 80, 95])
    for r in rows:
        s = r["difficulty_score"]
        if s < p50:
            idx = 0  # easy, by difficulty alone
        elif s < p80:
            idx = 1  # medium
        elif s < p95:
            idx = 2  # hard
        else:
            idx = 3  # nightmare
        # Demote into a harder (looser-floor) tier until the word's commonness actually clears
        # that tier's floor. "nightmare" has a floor of 0, so this always terminates.
        while r["commonness"] < COMMONNESS_FLOOR[BIN_ORDER[idx]]:
            idx += 1
        r["difficulty_bin"] = BIN_ORDER[idx]
    return p50, p80, p95


def load_rows_from_csv(csv_path: Path) -> list[dict]:
    """Re-load a previously-written table (for --rebin-only re-runs that tweak bin thresholds
    without repeating the expensive solver simulation)."""
    rows = []
    with csv_path.open(newline="") as f:
        for row in csv.DictReader(f):
            row["length"] = int(row["length"])
            row["commonness"] = float(row["commonness"])
            row["difficulty_score"] = float(row["difficulty_score"])
            row["num_steps"] = int(row["num_steps"])
            row["num_wrong"] = int(row["num_wrong"])
            rows.append(row)
    return rows


def write_outputs(rows: list[dict], csv_path: Path, words_dir: Path) -> None:
    p50, p80, p95 = assign_bins(rows)
    print(
        f"\nBin cutoffs (difficulty_score): "
        f"easy<{p50:.2f}<=medium<{p80:.2f}<=hard<{p95:.2f}<=nightmare"
        f"  (commonness floors: {COMMONNESS_FLOOR})"
    )

    bins: dict[str, list[dict]] = {name: [] for name in BIN_ORDER}
    for r in rows:
        bins[r["difficulty_bin"]].append(r)
    for name, bucket_rows in bins.items():
        sample = ", ".join(r["word"] for r in sorted(bucket_rows, key=lambda r: r["word"])[:6])
        print(f"  {name:>9}: {len(bucket_rows):>7,} words  e.g. {sample}")

    csv_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "word",
        "length",
        "commonness",
        "difficulty_score",
        "num_steps",
        "num_wrong",
        "difficulty_bin",
    ]
    with csv_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(sorted(rows, key=lambda r: r["word"]))
    print(f"\nWrote {csv_path} ({len(rows):,} rows)")

    words_dir.mkdir(parents=True, exist_ok=True)
    for name, bucket_rows in bins.items():
        path = words_dir / f"hangman_{name}.txt"
        path.write_text("\n".join(sorted(r["word"] for r in bucket_rows)) + "\n")
        print(f"Wrote {path} ({len(bucket_rows):,} words)")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--input", help="Source word list (.txt, one word per line) -- required unless --rebin-only"
    )
    parser.add_argument(
        "--rebin-only",
        action="store_true",
        help=(
            "Skip the (slow) solver simulation and just re-bin --csv-output's existing rows "
            "with the current COMMONNESS_FLOOR/percentile logic -- for tuning thresholds quickly."
        ),
    )
    parser.add_argument(
        "--csv-output",
        default="data/hangman_word_difficulty.csv",
        help="Where to read (with --rebin-only) / write the full per-word table",
    )
    parser.add_argument(
        "--words-output-dir",
        default="games/words",
        help="Directory for the regenerated hangman_<bin>.txt files (default: games/words)",
    )
    args = parser.parse_args()

    csv_path = Path(args.csv_output)

    if args.rebin_only:
        if not csv_path.exists():
            parser.error(f"--rebin-only needs an existing {csv_path} to re-bin")
        rows = load_rows_from_csv(csv_path)
        print(f"Loaded {len(rows):,} rows from {csv_path}")
        write_outputs(rows, csv_path, Path(args.words_output_dir))
        return

    if not args.input:
        parser.error("--input is required unless --rebin-only is set")

    try:
        import numpy as np  # noqa: F401  (import-checked here so the error message is clear)
        from wordfreq import zipf_frequency
    except ImportError:
        parser.error(
            "numpy/wordfreq are not installed. Run via:\n"
            "  uv run --with numpy --with wordfreq scripts/compute_hangman_difficulty.py ..."
        )

    src = Path(args.input)
    if not src.exists():
        parser.error(f"Input file not found: {src}")

    words = load_words(src)
    print(f"Found {len(words):,} candidate words ({MIN_LENGTH}-{MAX_LENGTH} letters).")

    by_length: dict[int, set[str]] = {}
    for w in words:
        by_length.setdefault(len(w), set()).add(w)

    rows = []
    t0 = time.time()
    for length in sorted(by_length):
        bucket = by_length[length]
        t1 = time.time()
        rows.extend(process_length_bucket(length, bucket, zipf_frequency))
        print(f"  length {length:>2}: {len(bucket):>6,} words solved in {time.time() - t1:.1f}s")
    print(f"Solved {len(rows):,} words in {time.time() - t0:.1f}s total.")

    write_outputs(rows, csv_path, Path(args.words_output_dir))


if __name__ == "__main__":
    main()
