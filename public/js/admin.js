(function () {
  document.querySelectorAll('.admin-delete-event-form').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (!confirm('Delete this event and all its photos? This cannot be undone.')) {
        e.preventDefault();
      }
    });
  });
})();
