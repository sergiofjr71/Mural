'use strict';

window.PhotoShuffleService = (function () {
  function fisherYates(items) {
    const list = items.slice();
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list;
  }

  function shuffleAvoidImmediateRepeat(ids, previousLastId) {
    if (!ids.length) return [];
    if (ids.length === 1) return ids.slice();

    let attempts = 0;
    let shuffled = fisherYates(ids);
    while (
      previousLastId &&
      shuffled[0] === previousLastId &&
      attempts < 8
    ) {
      shuffled = fisherYates(ids);
      attempts += 1;
    }

    if (previousLastId && shuffled[0] === previousLastId && shuffled.length > 1) {
      const swapIndex = 1 + Math.floor(Math.random() * (shuffled.length - 1));
      const tmp = shuffled[0];
      shuffled[0] = shuffled[swapIndex];
      shuffled[swapIndex] = tmp;
    }

    return shuffled;
  }

  function nextIndex(currentIndex, total) {
    if (!total) return 0;
    return (currentIndex + 1) % total;
  }

  return {
    fisherYates,
    shuffleAvoidImmediateRepeat,
    nextIndex,
  };
})();
