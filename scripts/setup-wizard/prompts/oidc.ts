import { promptWithHelp } from '../utils/prompt-with-help';
import type { OidcConfig } from '../types';

export interface OidcAnswers {
  configureOidc: boolean;
  oidc?: OidcConfig;
}

/** Prompts for OIDC authentication provider configuration. */
export async function promptOidc(): Promise<OidcAnswers> {
  const answers = await promptWithHelp<OidcAnswers>([
    {
      type: 'confirm',
      name: 'configureOidc',
      message: 'Use a third-party OIDC authentication provider?',
      default: false,
      help: `OpenID Connect (OIDC) provides user authentication.
Third-party providers include Zitadel, Auth0, and Keycloak.
If you skip OIDC, the system uses a stub provider for local development.`,
    },
  ]);

  if (answers.configureOidc) {
    answers.oidc = await promptWithHelp<OidcConfig>([
      {
        type: 'input',
        name: 'issuerUrl',
        message: 'OIDC issuer URL:',
        validate: (input: string) =>
          input.trim().length > 0 || 'Issuer URL cannot be empty',
        help: `The issuer URL is the provider's discovery endpoint.
  - Zitadel: https://your-instance.zitadel.cloud
  - Keycloak: http://localhost:8080/realms/your-realm
  - Auth0: https://your-tenant.auth0.com/`,
      },
      {
        type: 'input',
        name: 'clientId',
        message: 'OIDC client ID:',
        validate: (input: string) =>
          input.trim().length > 0 || 'Client ID cannot be empty',
        help: `The client ID is the application identifier from your OIDC provider.
  - Found in the provider's application/client settings
  - For Zitadel: create a "Web" application type
  - For Keycloak: create a "openid-connect" client`,
      },
      {
        type: 'input',
        name: 'clientSecret',
        message: 'OIDC client secret:',
        validate: (input: string) =>
          input.trim().length > 0 || 'Client secret cannot be empty',
        help: `The client secret is the confidential secret for your OIDC application.
  - Found in the provider's application/client settings
  - Keep this secret — do not commit it to version control`,
      },
    ]);
  }

  return answers;
}
