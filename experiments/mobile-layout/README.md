# Pibo mobile layout experiment

Isolated two-page evaluation based on `e1b7d97`. It does not change the shipped GUI, runtime, authentication protocols or production dependencies. All conversations and authentication states are synthetic; the password field accepts only `TEST` and never persists it. Do not enter real credentials.

## Run and build

From the repository root with Node 24+ and root dependencies installed:

```sh
npm --prefix experiments/mobile-layout ci --ignore-scripts
node experiments/mobile-layout/build.mjs
```

The build goes to ignored `artifacts/mobile-layout/bundled`. Serve the repository using Vite for browser inspection, or point a separately identified simulator-only Tauri build at that bundled directory. No Capacitor plugin is installed.

## Ownership

- The existing visualViewport/native-page-origin adapter owns available height and outer document stability. Ionic scrollAssist/scrollPadding/inputBlurring are explicitly disabled.
- Each IonPage has one IonContent scroll host. Header and footer are siblings; messages, forms and long inputs scroll internally.
- IonModal contains its own header/content/footer. Actions remain in the footer, outside the form's scroll region. Native accessory/keyboard remains system-owned.
- Existing ComposerFrame and its Radix upward attachment menu are reused. Ionic core CSS is scoped to this experiment entry; it is not imported into the shipped app.
- React is explicitly aliased to one experiment copy by build.mjs to avoid duplicate React across Ionic and existing Pibo controls.

## Evaluation limits

This is a layout proof, not a provider integration or full redesign. Device-code authorization, key storage, model requests, user data, router migration and bot-specific model overrides are not implemented. Error/cancel/complete states are synthetic. Existing production protocol work must remain separate.

Official references: https://ionicframework.com/docs/api/content (one content per view), https://ionicframework.com/docs/layout/structure, https://ionicframework.com/docs/developing/keyboard. Capacitor keyboard APIs are not available merely by importing Ionic in Tauri.

## Result (isolated iPhone 17 / iOS 26.4 simulator, Tauri 2.12.3)

**Do not migrate the shipped UI on the basis of this experiment.** Ionic page structure improves explicit scroll ownership and the model onboarding sequence, but does not replace native keyboard/rotation coordination in Tauri.

- Production source unchanged; experiment branch starts from e1b7d97.
- Main XCTest flow passed: visible chat software keyboard, stable header, English multiline, provider page, synthetic TEST secret entry, visible completion action, authenticated synthetic state and repeat focus.
- Extended run executed Chinese multiline, independent long-chat scrolling, attachment menu, error/cancel and rotation. The run is NOT green: attachment geometry assertion compares against a cached pre-keyboard-dismissal textarea location (732 vs 394). Screenshot confirms menu above the relocated composer, so that assertion needs a post-layout geometry oracle.
- Landscape screenshot has a large black region/cropping. This is an unresolved candidate acceptance failure, not proof of the exact native cause. Do not label landscape or safe-area acceptance passed.
- Secure-input screenshot omits the system keyboard image; the action is hittable in XCTest, but native secure keyboard rendering is not demonstrated by that screenshot.
- No true Chinese IME candidate-composition, VoiceOver, true-device or runtime/provider authentication test was performed.
- Root typecheck and Vite bundled build passed. 21st deterministic review: zero findings. Root ESLint ignores experiments; do not claim experiment lint passed.
- Test sources are retained under tests/. Test result bundles and screenshots live under ignored artifacts/mobile-layout/. The test runner launches only dev.pibot.ionic-experiment.

Cost/boundary: 38 installed packages, about 104 MB local dependency tree; scoped package and lockfile, no root dependency changes. Adopting this in production would require router/modal/focus integration, strict CSS scoping, keyboard/rotation native telemetry and accessibility regression work. For now reuse the one-scroll-host/header/content/footer design and the provider-first flow; retain Tauri and the proven e1b7d97 fix.

Official component defaults were checked against installed input-shims implementation: scrollAssist and scrollPadding can add independent keyboard compensation, so both are disabled here. No Capacitor keyboard functionality is claimed.
