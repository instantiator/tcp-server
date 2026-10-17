import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { t } from '../../strings';
import { useLocalAddressCheck } from './useLocalAddressCheck';

/** Checks one address on a button press and shows what would be saved. */
const Harness = ({ url }: { url: string }) => {
  const { check, dialog } = useLocalAddressCheck();
  const [saved, setSaved] = useState('');
  return (
    <>
      <button onClick={() => void check(url).then(setSaved)}>Save</button>
      <output>{saved}</output>
      {dialog}
    </>
  );
};

describe('useLocalAddressCheck', () => {
  it('passes a non-local address straight through', async () => {
    const user = userEvent.setup();
    render(<Harness url="http://gpu-box.lan:1234/v1" />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await screen.findByText('http://gpu-box.lan:1234/v1')).toBeVisible();
  });

  it.each([
    [t('llm.local.replace'), 'http://host.docker.internal:1234/v1'],
    [t('llm.local.keep'), 'http://localhost:1234/v1'],
  ])('asks about localhost, and %s saves %s', async (choice, expected) => {
    const user = userEvent.setup();
    render(<Harness url="http://localhost:1234/v1" />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: choice }));
    expect(await screen.findByText(expected)).toBeVisible();
  });
});
