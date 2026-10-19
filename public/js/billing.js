(function () {
  const amountField = document.getElementById('amountCents');
  const customAmount = document.getElementById('customAmount');
  const presetRadios = document.querySelectorAll('input[name=preset]');

  presetRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      customAmount.value = '';
      amountField.value = radio.dataset.amount;
    });
  });

  customAmount.addEventListener('input', () => {
    const dollars = parseFloat(customAmount.value);
    if (dollars > 0) {
      presetRadios.forEach((r) => (r.checked = false));
      amountField.value = Math.round(dollars * 100);
    }
  });
})();
