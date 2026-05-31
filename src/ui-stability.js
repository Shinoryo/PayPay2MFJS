/**
 * Datepicker が submit ボタンを覆ってクリックを阻害しないように、保存前の
 * クローズ手順を試行する。親モーダルへの副作用を避けるため Escape は使わない。
 * close ステップで失敗しても処理は継続し、診断情報を返す。
 *
 * @returns {{
 *   ok: boolean,
 *   closeWaitMs: number,
 *   steps: {
 *     blurInput: { ok: boolean, error: string | null },
 *     pressTab: { ok: boolean, error: string | null },
 *     clickModalSafeArea: { ok: boolean, error: string | null },
 *     waitDatepickerHidden: { ok: boolean, error: string | null }
 *   }
 * }}
 */
const DATEPICKER_SELECTOR = '.datepicker.dropdown-menu';

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function runCloseStep(result, stepName, fn) {
  try {
    await fn();
  } catch (error) {
    result.ok = false;
    result.steps[stepName] = {
      ok: false,
      error: toErrorMessage(error)
    };
  }
}

async function closeDatepickerBeforeSubmit(page, selectors, mfmeConfig) {
  const closeWaitMs = Math.min(mfmeConfig.timeoutsMs.action, 1500);
  const dateInput = page.locator(selectors.dateInput);
  const result = {
    ok: true,
    closeWaitMs,
    steps: {
      blurInput: { ok: true, error: null },
      pressTab: { ok: true, error: null },
      clickModalSafeArea: { ok: true, error: null },
      waitDatepickerHidden: { ok: true, error: null }
    }
  };

  await runCloseStep(result, 'blurInput', () => dateInput.evaluate((input) => {
    if (input && typeof input.blur === 'function') {
      input.blur();
    }
  }, undefined, { timeout: closeWaitMs }));

  await runCloseStep(result, 'pressTab', () => dateInput.press('Tab', { timeout: closeWaitMs }));

  if (selectors.manualFormModal) {
    await runCloseStep(result, 'clickModalSafeArea', () => page.locator(selectors.manualFormModal).click({
      position: { x: 8, y: 8 },
      timeout: closeWaitMs
    }));
  }

  await runCloseStep(result, 'waitDatepickerHidden', () => page.waitForFunction((selector) => {
    const datepickers = Array.from(document.querySelectorAll(selector));
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
  }, DATEPICKER_SELECTOR, { timeout: closeWaitMs }));

  return result;
}

module.exports = {
  closeDatepickerBeforeSubmit
};
