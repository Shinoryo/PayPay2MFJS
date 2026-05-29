const test = require('node:test');
const assert = require('node:assert/strict');

const {
  closeDatepickerBeforeSubmit
} = require('../src/ui-stability');

function createPageMock(options = {}) {
  const calls = [];

  const dateInputLocator = {
    async press(key) {
      calls.push(`press:${key}`);
      if (options.pressReject) {
        throw new Error('press failed');
      }
    },
    async evaluate(fn) {
      calls.push('evaluate');
      if (options.evaluateReject) {
        throw new Error('evaluate failed');
      }
      const fakeInput = {
        blurCalled: false,
        blur() {
          this.blurCalled = true;
        }
      };
      fn(fakeInput);
      return fakeInput.blurCalled;
    }
  };

  const modalLocator = {
    async click() {
      calls.push('click:manualFormModal');
      if (options.modalClickReject) {
        throw new Error('modal click failed');
      }
    }
  };

  return {
    calls,
    locator(selector) {
      calls.push(`locator:${selector}`);
      if (selector === '#manual-form-modal') {
        return modalLocator;
      }
      return dateInputLocator;
    },
    async waitForFunction(_predicate, waitOptions) {
      calls.push(`waitForFunction:${waitOptions.timeout}`);
      if (options.waitReject) {
        throw new Error('wait failed');
      }
    }
  };
}

test('closeDatepickerBeforeSubmit attempts close steps in order', async () => {
  const page = createPageMock();
  const selectors = { dateInput: '#updated-at', manualFormModal: '#manual-form-modal' };
  const mfmeConfig = { timeoutsMs: { action: 10000 } };

  const result = await closeDatepickerBeforeSubmit(page, selectors, mfmeConfig);

  assert.deepEqual(page.calls, [
    'locator:#updated-at',
    'evaluate',
    'press:Tab',
    'locator:#manual-form-modal',
    'click:manualFormModal',
    'waitForFunction:1500'
  ]);
  assert.deepEqual(result, {
    ok: true,
    closeWaitMs: 1500,
    steps: {
      blurInput: { ok: true, error: null },
      pressTab: { ok: true, error: null },
      clickModalSafeArea: { ok: true, error: null },
      waitDatepickerHidden: { ok: true, error: null }
    }
  });
});

test('closeDatepickerBeforeSubmit swallows close step errors and keeps going', async () => {
  const page = createPageMock({
    pressReject: true,
    evaluateReject: true,
    modalClickReject: true,
    waitReject: true
  });
  const selectors = { dateInput: '#updated-at', manualFormModal: '#manual-form-modal' };
  const mfmeConfig = { timeoutsMs: { action: 800 } };

  const result = await closeDatepickerBeforeSubmit(page, selectors, mfmeConfig);

  assert.deepEqual(page.calls, [
    'locator:#updated-at',
    'evaluate',
    'press:Tab',
    'locator:#manual-form-modal',
    'click:manualFormModal',
    'waitForFunction:800'
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.steps.blurInput.ok, false);
  assert.match(result.steps.blurInput.error, /evaluate failed/);
  assert.equal(result.steps.pressTab.ok, false);
  assert.match(result.steps.pressTab.error, /press failed/);
  assert.equal(result.steps.clickModalSafeArea.ok, false);
  assert.match(result.steps.clickModalSafeArea.error, /modal click failed/);
  assert.equal(result.steps.waitDatepickerHidden.ok, false);
  assert.match(result.steps.waitDatepickerHidden.error, /wait failed/);
});

test('closeDatepickerBeforeSubmit returns diagnostics when some close steps fail', async () => {
  const page = createPageMock({ pressReject: true, waitReject: true });
  const selectors = { dateInput: '#updated-at' };
  const mfmeConfig = { timeoutsMs: { action: 800 } };

  const result = await closeDatepickerBeforeSubmit(page, selectors, mfmeConfig);

  assert.equal(result.ok, false);
  assert.equal(result.closeWaitMs, 800);
  assert.deepEqual(result.steps.blurInput, { ok: true, error: null });
  assert.equal(result.steps.pressTab.ok, false);
  assert.match(result.steps.pressTab.error, /press failed/);
  assert.deepEqual(result.steps.clickModalSafeArea, { ok: true, error: null });
  assert.equal(result.steps.waitDatepickerHidden.ok, false);
  assert.match(result.steps.waitDatepickerHidden.error, /wait failed/);
});
