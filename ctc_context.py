"""Conservative vocabulary bias for the GigaAM ONNX CTC decoder."""

import re

import numpy as np


def _terms(pieces, vocabulary):
    pieces_text = {value.replace("▁", " ").lower() for value in pieces.values()}
    chars = set("".join(pieces_text))
    return {
        term.lower() for term in vocabulary
        if len(term) >= 3 and term[0].isalpha() and term[-1].isalnum()
        and set(term.lower()) <= chars
    }


def frame_ids(log_probs, pieces, blank, vocabulary):
    """Search near the greedy path and reward only complete, acoustically plausible terms."""
    greedy = log_probs.argmax(axis=-1)
    terms = _terms(pieces, vocabulary)
    if not terms:
        return greedy

    pattern = re.compile(r"(?<!\w)(?:" + "|".join(map(re.escape, sorted(terms, key=lambda v: (-len(v), v))))
                         + r")(?!\w)")
    # A phrase is complete only when a non-word follows it, or at the final frame.
    tail_size = max(map(len, terms)) + 2
    top = np.argpartition(log_probs, -min(5, log_probs.shape[1]), axis=-1)[:, -5:]
    # (last raw token, suffix) -> (relative score, completed boosts, linked frame path)
    beam = {(-1, ""): (0.0, 0, None)}
    for frame, row in enumerate(log_probs):
        best = greedy[frame]
        candidates = set(map(int, top[frame])) | {blank}
        candidates = [token for token in sorted(candidates) if row[best] - row[token] <= 1.4]
        proposed = {}
        for (previous, suffix), (score, hits, path) in beam.items():
            for token in candidates:
                delta = float(row[token] - row[best])
                text = suffix
                completed = 0
                if token != blank and token != previous:
                    piece = pieces.get(token, "").replace("▁", " ").lower()
                    text += piece
                    completed = sum(
                        match.end() >= len(suffix) and match.end() < len(text)
                        for match in pattern.finditer(text)
                    )
                key = token, text[-tail_size:]
                value = score + delta + 1.25 * completed
                if key not in proposed or value > proposed[key][0]:
                    proposed[key] = (value, hits + completed, (token, path))
        beam = dict(sorted(proposed.items(), key=lambda item: item[1][0], reverse=True)[:8])

    best_score = 0.0
    best_path = None
    for (_, suffix), (score, hits, path) in beam.items():
        final_hits = sum(match.end() == len(suffix) for match in pattern.finditer(suffix))
        final_score = score + 1.25 * final_hits
        if hits + final_hits and final_score > best_score:
            best_score, best_path = final_score, path
    if best_path is None:
        return greedy

    # A term the greedy path already contained cannot subsidize unrelated edits.
    text = []
    previous = -1
    for token in greedy:
        if token != blank and token != previous:
            text.append(pieces.get(int(token), "").replace("▁", " ").lower())
        previous = token
    if best_score <= 1.25 * len(pattern.findall("".join(text))):
        return greedy

    path = best_path
    ids = np.empty_like(greedy)
    for frame in range(len(ids) - 1, -1, -1):
        ids[frame], path = path
    return ids
