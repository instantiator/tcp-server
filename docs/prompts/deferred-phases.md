## Unplanned, missing features

### Company definitions as zip files

- Contains a company
- Contains roles
- Contains knowledge
- tcp-cli can unzip and set company, roles, and knowledge for roles
- probably roles will need a way to declare the source files to use

### Default admin user provision

- Currently we provide a test user in config
- We need a way to easily assign an admin user
- If using provided Zitadel, it should be possible to create or assign the admin user through tcp-cli
- If using an external OIDC service, it should be easy to assign the admin user through tcp-cli or config (and the creation of the admin user is an exercise for the owner of the OIDC service)
