## Missing features

### Company definitions as zip files

- Contains a company
- Contains roles
- Contains knowledge
- tcp-cli can unzip and set company, roles, and knowledge for roles
- probably roles will need a way to declare the source files to use

### Default admin user

- Currently we provide a test user in config
- We need a way to easily assign an admin user
- If using provided Zitadel, the admin user should be created through tcp-cli
- If using an external OIDC service, it should be easy to assign the admin user through config (ie. the creation of the admin user is an exercise for the owner of the OIDC service)
