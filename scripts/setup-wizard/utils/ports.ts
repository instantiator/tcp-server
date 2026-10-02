/** True for a valid TCP port number (1-65535). */
export function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value < 65536;
}
