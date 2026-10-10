import { ProcessRestarter, restartSupported } from './process-restarter';

describe('ProcessRestarter', () => {
  let kill: jest.SpyInstance;
  let exit: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    exit = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    jest.useRealTimers();
    kill.mockRestore();
    exit.mockRestore();
  });

  it('asks for a clean shutdown after a second, so in-flight replies go out first', () => {
    new ProcessRestarter().restart();
    expect(kill).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(exit).not.toHaveBeenCalled();
  });

  // A client polling over a kept-alive connection held a real restart open
  // for as long as it kept asking.
  it('exits anyway when the clean shutdown hangs', () => {
    new ProcessRestarter().restart();
    jest.advanceTimersByTime(11_000);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('restartSupported', () => {
  it.each([
    [true, true],
    ['true', true],
    [false, false],
    ['false', false],
    [undefined, false],
  ])('reads %p as %p', (value, expected) => {
    expect(restartSupported(value)).toBe(expected);
  });
});
