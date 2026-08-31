## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The problem it solves. If it is an Arc quirk, say what Arc does. -->

## Test plan

<!--
Both parts, where they apply. Anything Arc-facing needs a manual check, since
CI runs on Linux with no Arc.
-->

- [ ] `npm test` passes
- [ ] Tested by hand against Arc (macOS version, Arc version, and what you ran):
- [ ] Added or updated unit tests, or explained why the logic is not testable
      without Arc

## Checklist

- [ ] No tool reports success it has not verified
- [ ] Tool arguments still go through `P`, never concatenated into script source
- [ ] New or changed tools listed in the README tool reference
- [ ] CHANGELOG entry added under `Unreleased`
- [ ] A new tool module is registered in `src/registry.js`
