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

  return {
    calls,
    locator(selector) {
      calls.push(`locator:${selector}`);
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
  const selectors = { dateInput: '#updated-at' };
  const mfmeConfig = { timeoutsMs: { action: 10000 } };

  await closeDatepickerBeforeSubmit(page, selectors, mfmeConfig);

  assert.deepEqual(page.calls, [
    'locator:#updated-at',
    'press:Escape',
    'locator:#updated-at',
    'evaluate',
    'waitForFunction:1500'
  ]);
});

test('closeDatepickerBeforeSubmit swallows close step errors and keeps going', async () => {
  const page = createPageMock({ pressReject: true, evaluateReject: true, waitReject: true });
  const selectors = { dateInput: '#updated-at' };
  const mfmeConfig = { timeoutsMs: { action: 800 } };

  await assert.doesNotReject(() => closeDatepickerBeforeSubmit(page, selectors, mfmeConfig));

  assert.deepEqual(page.calls, [
    'locator:#updated-at',
    'press:Escape',
    'locator:#updated-at',
    'evaluate',
    'waitForFunction:800'
  ]);
});
