import { loadConfigFile, type StubLlmConfig } from './config.ts';
import { createStubLlmServer } from './server.ts';

function parseArgs(argv: string[]): { configPath?: string; port?: number } {
  let configPath: string | undefined;
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') {
      const value = argv[i + 1];
      if (value) configPath = value;
      i++;
    } else if (arg === '--port') {
      const value = argv[i + 1];
      if (value) port = Number(value);
      i++;
    }
  }
  return { configPath, port };
}

async function main(): Promise<void> {
  const { configPath, port } = parseArgs(process.argv.slice(2));
  const configFile = configPath ?? process.env.STUB_LLM_CONFIG_FILE;
  const config: StubLlmConfig = configFile
    ? await loadConfigFile(configFile)
    : {};
  const resolvedPort = port ?? Number(process.env.PORT ?? '3002');

  const server = createStubLlmServer(config);
  server.listen(resolvedPort, () => {
    const configNote = configFile
      ? ` (config: ${configFile})`
      : ' (no config file — defaults only)';
    console.log(`tcp-stub-llm listening on :${resolvedPort}${configNote}`);
  });
}

main().catch((cause: unknown) => {
  console.error(cause);
  process.exitCode = 1;
});
