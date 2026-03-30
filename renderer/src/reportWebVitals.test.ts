test('reportWebVitals does nothing when callback is missing', async () => {
  jest.resetModules();
  const mod = require('./reportWebVitals');
  const reportWebVitals = mod.default;
  const loadSpy = jest.spyOn(mod.__testUtils, 'loadWebVitals');

  reportWebVitals();
  expect(loadSpy).not.toHaveBeenCalled();

  await mod.__testUtils.loadWebVitals();
  await Promise.resolve();
  await Promise.resolve();

  expect(loadSpy).toHaveBeenCalledTimes(1);
});

test('reportWebVitals wires all web-vitals callbacks when a handler is provided', async () => {
  jest.resetModules();
  const mockGetCLS = jest.fn();
  const mockGetFID = jest.fn();
  const mockGetFCP = jest.fn();
  const mockGetLCP = jest.fn();
  const mockGetTTFB = jest.fn();

  const mod = require('./reportWebVitals');
  const reportWebVitals = mod.default;
  const onPerfEntry = () => undefined;
  jest.spyOn(mod.__testUtils, 'loadWebVitals').mockResolvedValue({
    getCLS: mockGetCLS,
    getFID: mockGetFID,
    getFCP: mockGetFCP,
    getLCP: mockGetLCP,
    getTTFB: mockGetTTFB,
  });

  reportWebVitals(onPerfEntry);
  await Promise.resolve();
  await Promise.resolve();

  expect(mockGetCLS).toHaveBeenCalledWith(onPerfEntry);
  expect(mockGetFID).toHaveBeenCalledWith(onPerfEntry);
  expect(mockGetFCP).toHaveBeenCalledWith(onPerfEntry);
  expect(mockGetLCP).toHaveBeenCalledWith(onPerfEntry);
  expect(mockGetTTFB).toHaveBeenCalledWith(onPerfEntry);
});
