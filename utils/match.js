// Lower = stricter (fewer false positives, more missed matches). 0.6 is the
// commonly-cited "same person" cutoff for this descriptor model; 0.55 still
// let through enough false positives in practice — with a gallery of a
// thousand-plus photos (and several faces per photo), even a low per-pair
// false-positive rate compounds into a real chance some unrelated selfie
// coincidentally lands within threshold of *something*. Tightened to trade
// some recall for noticeably fewer "that's not me" results.
const MATCH_THRESHOLD = 0.45;

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

module.exports = { euclideanDistance, MATCH_THRESHOLD };
