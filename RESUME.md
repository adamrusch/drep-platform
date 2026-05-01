# DRep Platform — Build Status

## Complete ✅
- Monorepo structure (infra/, backend/, frontend/, shared/)
- AWS CDK stacks: DatabaseStack, ApiStack, FrontendStack, SchedulerStack
- All Phase 1 DynamoDB tables defined
- All Phase 1 Lambda handlers scaffolded (auth, governance, comments, clubhouse, drep, profile)
- Backend lib: dynamodb client, blockfrost wrapper, JWT auth, shared types
- JWT authorizer Lambda + role-guard middleware
- Blockfrost governance-intake sync (EventBridge-triggered)
- React frontend: all pages, components, hooks, stores, auth
- Design system integrated (custom CSS + Cardano brand tokens)
- App shell: topbar, sidebar, routing
- TypeScript compiles clean in all workspaces
- npm deps installed in all workspaces

## In Progress / Next Steps
- [ ] Initialize GitHub repo and push (user needs to confirm repo name)
- [ ] Set Blockfrost API key in AWS Secrets Manager
- [ ] `cdk deploy --profile drep-platform` for dev environment
- [ ] SES email identity verification in AWS console
- [ ] Phase 1-B: Implement real CIP-30 signature verification in auth/verify.ts (currently stubbed with TODO)
- [ ] Phase 1-C: Connect frontend to deployed API (update VITE_API_BASE_URL)
- [ ] Phase 1-D: Write tests

## Key Decisions Made
- Design system uses custom CSS classes (not Tailwind utilities) for components, matching the design handoff exactly
- Tailwind used for layout utilities and extends brand colors from design tokens
- Wallet signature verification stubbed pending CSL/cardano-crypto library decision
- CDK targets: account 409410541898, region us-east-1, stage dev, Cardano network: preview
- All AWS operations use `--profile drep-platform`

## AWS Account
- Account: 409410541898
- Region: us-east-1
- CDK bootstrapped: ✅
- Profile: drep-platform
