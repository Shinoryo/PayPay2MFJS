/**
 * Datepicker が submit ボタンを覆ってクリックを阻害しないように、保存前の
 * クローズ手順を試行する。close ステップで失敗しても処理は継続し、診断情報を返す。
 *
 * @returns {{
 *   ok: boolean,
 *   closeWaitMs: number,
 *   steps: {
 *     pressEscape: { ok: boolean, error: string | null },
 *     blurInput: { ok: boolean, error: string | null },
 *     waitDatepickerHidden: { ok: boolean, error: string | null }
 *   }
 * }}
 */
async function closeDatepickerBeforeSubmit(page, selectors, mfmeConfig) {
  const closeWaitMs = Math.min(mfmeConfig.timeoutsMs.action, 1500);
  const dateInput = page.locator(selectors.dateInput);
  const result = {
    ok: true,
    closeWaitMs,
    steps: {
      pressEscape: { ok: true, error: null },
      blurInput: { ok: true, error: null },
      waitDatepickerHidden: { ok: true, error: null }
    }
  };

  await dateInput.press('Escape', { timeout: closeWaitMs }).catch((error) => {
    result.ok = false;
    result.steps.pressEscape = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  });
  await dateInput.evaluate((input) => {
    if (input && typeof input.blur === 'function') {
      input.blur();
    }
  }, { timeout: closeWaitMs }).catch((error) => {
    result.ok = false;
    result.steps.blurInput = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  });

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
  }, { timeout: closeWaitMs }).catch((error) => {
    result.ok = false;
    result.steps.waitDatepickerHidden = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  });

  return result;
}

module.exports = {
  closeDatepickerBeforeSubmit
};
