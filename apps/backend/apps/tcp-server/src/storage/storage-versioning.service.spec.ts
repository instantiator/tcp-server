import { retentionRules } from './storage-versioning.service';

describe('retentionRules', () => {
  it('gives the soft-delete folder the default when there are no companies', () => {
    expect(retentionRules([], 90)).toEqual([
      {
        ID: 'soft-deleted',
        Status: 'Enabled',
        Filter: { Prefix: '_deleted/' },
        NoncurrentVersionExpiration: { NoncurrentDays: 90 },
        Expiration: { ExpiredObjectDeleteMarker: true },
      },
    ]);
  });

  it("uses a company's own days, or the default when it has none", () => {
    const rules = retentionRules(
      [
        { slug: 'acme', versionRetentionDays: 365 },
        { slug: 'jam-co', versionRetentionDays: null },
        { slug: 'quiet' },
      ],
      90,
    );
    expect(
      rules.map((r) => [
        r.ID,
        r.Filter?.Prefix,
        r.NoncurrentVersionExpiration?.NoncurrentDays,
      ]),
    ).toEqual([
      ['soft-deleted', '_deleted/', 90],
      ['company-acme', 'acme/', 365],
      ['company-jam-co', 'jam-co/', 90],
      ['company-quiet', 'quiet/', 90],
    ]);
  });

  it('clears expired delete markers in every rule', () => {
    const rules = retentionRules([{ slug: 'acme' }], 30);
    expect(
      rules.every((r) => r.Expiration?.ExpiredObjectDeleteMarker === true),
    ).toBe(true);
  });
});
