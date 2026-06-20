import { AgentRegistryService } from './agent-registry.service';

describe('AgentRegistryService', () => {
  let service: AgentRegistryService;

  beforeEach(() => {
    service = new AgentRegistryService();
  });

  it('reports isRunning:false for an unregistered agent', () => {
    expect(service.isRunning('unknown')).toBe(false);
  });

  it('reports isRunning:true after registering', () => {
    const ac = new AbortController();
    service.register('agent-1', ac);
    expect(service.isRunning('agent-1')).toBe(true);
  });

  it('reports isRunning:false after deregistering', () => {
    const ac = new AbortController();
    service.register('agent-1', ac);
    service.deregister('agent-1');
    expect(service.isRunning('agent-1')).toBe(false);
  });

  it('replaces an existing entry when registering the same id', () => {
    const first = new AbortController();
    const second = new AbortController();
    service.register('agent-1', first);
    service.register('agent-1', second);
    expect(service.activeCount).toBe(1);
    expect(service.isRunning('agent-1')).toBe(true);
  });

  it('tracks activeCount correctly across register/deregister', () => {
    service.register('a', new AbortController());
    service.register('b', new AbortController());
    expect(service.activeCount).toBe(2);
    service.deregister('a');
    expect(service.activeCount).toBe(1);
    service.deregister('b');
    expect(service.activeCount).toBe(0);
  });
});
