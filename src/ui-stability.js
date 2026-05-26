async function closeDatepickerBeforeSubmit(page, selectors, mfmeConfig) {
  const closeWaitMs = Math.min(mfmeConfig.timeoutsMs.action, 1500);

  await page.locator(selectors.dateInput).press('Escape').catch(() => {});
  await page.locator(selectors.dateInput).evaluate((input) => {
    if (input && typeof input.blur === 'function') {
      input.blur();
    }
  }).catch(() => {});

  await page.waitForFunction(() => {
    const datepickers = Array.from(document.querySelectorAll('.datepicker.dropdown-menu'));
    if (datepickers.length === 0) {
      return true;
    }

    return datepickers.every((node) => {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return true;
      }
      const rect = node.getBoundingClientRect();
      return rect.width === 0 || rect.height === 0;
    });
  }, { timeout: closeWaitMs }).catch(() => {});
}

module.exports = {
  closeDatepickerBeforeSubmit
};
