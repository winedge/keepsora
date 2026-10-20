(function () {
  var btn = document.getElementById('navToggle');
  var links = document.getElementById('navLinks');
  if (!btn || !links) return;

  function setOpen(open) {
    links.classList.toggle('open', open);
    btn.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  btn.addEventListener('click', function () {
    setOpen(!links.classList.contains('open'));
  });
  links.querySelectorAll('a, button').forEach(function (el) {
    el.addEventListener('click', function () { setOpen(false); });
  });
})();
