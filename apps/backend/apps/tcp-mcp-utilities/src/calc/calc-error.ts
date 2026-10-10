/**
 * A user-correctable failure in a calculation, date or unit request. The
 * message is read by a small language model, so it says what was wrong and
 * what to write instead; `position` (0-based) points into the expression
 * when the problem has a place in it.
 */
export class CalcError extends Error {
  override readonly name = 'CalcError';

  constructor(
    message: string,
    readonly position?: number,
  ) {
    super(
      position === undefined ? message : `${message} (at position ${position})`,
    );
  }
}
