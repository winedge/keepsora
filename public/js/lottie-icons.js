// Auto-initializes every `<span/div class="lottie-icon" data-lottie="name">`
// on the page with the matching /lottie/<name>.json animation. Pages that use
// any lottie-icon element must also load /vendor/lottie.min.js before this.
(function () {
  if (typeof lottie === 'undefined') return;
  document.querySelectorAll('[data-lottie]').forEach((el) => {
    lottie.loadAnimation({
      container: el,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      path: `/lottie/${el.dataset.lottie}.json`,
    });
  });
})();
