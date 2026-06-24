#!/usr/bin/env python
"""Build word-ladder data: per-length commonality bins and an edit-adjacency graph.

Reuses the already-computed commonness column from data/hangman_word_difficulty.csv
(wordfreq's English zipf frequency over CSW21) rather than calling wordfreq again --
no extra dependency needed to run this script.

For every length 3..9 (one length above the highest word-ladder-selectable length, so
insert/delete-mode neighbors at the boundary exist):

  - bins words into easy/medium/hard/nightmare using the same commonness thresholds
    Hangman uses (>=4.0 / >=2.5 / >=1.0 / else), written to games/words/ladder_<len>_<tier>.txt
  - builds a same-length substitution adjacency via the standard wildcard-bucket technique
  - builds insertion/deletion adjacency between length L and L+1 (deleting one letter from an
    L+1 word and checking whether the result is a valid L word)
  - merges both into games/words/ladder_graph_<len>.json: {word: [neighbor, ...]}

Run with:

    uv run python scripts/compute_word_ladder_graph.py
"""

import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path

MIN_LENGTH = 3
MAX_LENGTH = 9

# Same cutoffs as compute_hangman_difficulty.py's COMMONNESS_FLOOR, used directly as bin
# boundaries here (no solver-difficulty axis for word ladder -- obscurity is the only one).
TIER_ORDER = ["easy", "medium", "hard", "nightmare"]
TIER_FLOOR = {"easy": 4.0, "medium": 2.5, "hard": 1.0, "nightmare": float("-inf")}


def tier_of(commonness: float) -> str:
    for tier in TIER_ORDER:
        if commonness >= TIER_FLOOR[tier]:
            return tier
    return "nightmare"  # unreachable (nightmare's floor is -inf), kept for clarity


def load_words_by_length(csv_path: Path) -> dict[int, dict[str, float]]:
    """length -> {word: commonness}, restricted to MIN_LENGTH..MAX_LENGTH."""
    by_length: dict[int, dict[str, float]] = defaultdict(dict)
    with csv_path.open(newline="") as f:
        for row in csv.DictReader(f):
            length = int(row["length"])
            if MIN_LENGTH <= length <= MAX_LENGTH:
                by_length[length][row["word"]] = float(row["commonness"])
    return by_length


def substitution_edges(words: list[str]) -> dict[str, set[str]]:
    """Wildcard-bucket technique: group words by every one-position-blanked pattern, then
    connect every pair sharing a bucket. O(N*L) buckets, not O(N^2) pairwise comparisons."""
    buckets: dict[str, list[str]] = defaultdict(list)
    for word in words:
        for i in range(len(word)):
            buckets[word[:i] + "*" + word[i + 1 :]].append(word)
    adjacency: dict[str, set[str]] = defaultdict(set)
    for group in buckets.values():
        if len(group) < 2:
            continue
        for a in group:
            adjacency[a].update(w for w in group if w != a)
    return adjacency


def indel_edges(shorter: list[str], longer: list[str]) -> dict[str, set[str]]:
    """Bidirectional edges between length-L and length-(L+1) words: an edge exists if deleting
    one letter from a `longer` word yields a `shorter` word."""
    shorter_set = set(shorter)
    adjacency: dict[str, set[str]] = defaultdict(set)
    for word in longer:
        for i in range(len(word)):
            candidate = word[:i] + word[i + 1 :]
            if candidate in shorter_set:
                adjacency[word].add(candidate)
                adjacency[candidate].add(word)
    return adjacency


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--csv-input", default="data/hangman_word_difficulty.csv")
    parser.add_argument("--words-output-dir", default="games/words")
    args = parser.parse_args()

    by_length = load_words_by_length(Path(args.csv_input))
    out_dir = Path(args.words_output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Bin + write tier files.
    for length, commonness in by_length.items():
        bins: dict[str, list[str]] = {t: [] for t in TIER_ORDER}
        for word, score in commonness.items():
            bins[tier_of(score)].append(word)
        for tier, bucket_words in bins.items():
            path = out_dir / f"ladder_{length}_{tier}.txt"
            path.write_text("\n".join(sorted(bucket_words)) + "\n" if bucket_words else "")
            print(f"  wrote {path} ({len(bucket_words):,} words)")

    # Build + write adjacency per length (substitution within length, indel with length-1/length+1).
    for length in sorted(by_length):
        words = list(by_length[length])
        adjacency = substitution_edges(words)

        shorter_len = length - 1
        if shorter_len in by_length:
            for word, neighbors in indel_edges(list(by_length[shorter_len]), words).items():
                adjacency.setdefault(word, set()).update(neighbors)

        longer_len = length + 1
        if longer_len in by_length:
            for word, neighbors in indel_edges(words, list(by_length[longer_len])).items():
                adjacency.setdefault(word, set()).update(neighbors)

        graph = {w: sorted(adjacency.get(w, ())) for w in words}
        path = out_dir / f"ladder_graph_{length}.json"
        path.write_text(json.dumps(graph, separators=(",", ":")))
        avg_degree = sum(len(v) for v in graph.values()) / max(len(graph), 1)
        print(f"  wrote {path} ({len(graph):,} words, avg degree {avg_degree:.1f})")


if __name__ == "__main__":
    main()
