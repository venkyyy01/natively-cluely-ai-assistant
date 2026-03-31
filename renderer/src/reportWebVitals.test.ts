import reportWebVitals, { __testUtils } from './reportWebVitals';

const originalLoadWebVitals = __testUtils.loadWebVitals;

describe('reportWebVitals', () => {
  afterEach(() => {
    __testUtils.loadWebVitals = originalLoadWebVitals;
    jest.restoreAllMocks();
  });

  test('loads web-vitals and registers every metric callback when a handler is provided', async () => {
    const onPerfEntry = () => {};
    const getCLS = jest.fn();
    const getFID = jest.fn();
    const getFCP = jest.fn();
    const getLCP = jest.fn();
    const getTTFB = jest.fn();

    const loadWebVitals = jest.fn().mockResolvedValue({
      getCLS,
      getFID,
      getFCP,
      getLCP,
      getTTFB,
    } as never);
    __testUtils.loadWebVitals = loadWebVitals as typeof __testUtils.loadWebVitals;

    reportWebVitals(onPerfEntry);
    await Promise.resolve();

    expect(loadWebVitals).toHaveBeenCalledTimes(1);
    expect(getCLS).toHaveBeenCalledWith(onPerfEntry);
    expect(getFID).toHaveBeenCalledWith(onPerfEntry);
    expect(getFCP).toHaveBeenCalledWith(onPerfEntry);
    expect(getLCP).toHaveBeenCalledWith(onPerfEntry);
    expect(getTTFB).toHaveBeenCalledWith(onPerfEntry);
  });

  test('does nothing when the performance handler is missing or invalid', async () => {
    const loadWebVitals = jest.fn().mockResolvedValue({
      getCLS: jest.fn(),
      getFID: jest.fn(),
      getFCP: jest.fn(),
      getLCP: jest.fn(),
      getTTFB: jest.fn(),
    } as never);
    __testUtils.loadWebVitals = loadWebVitals as typeof __testUtils.loadWebVitals;

    reportWebVitals();
    reportWebVitals('not-a-function' as never);
    await Promise.resolve();

    expect(loadWebVitals).not.toHaveBeenCalled();
  });
});
