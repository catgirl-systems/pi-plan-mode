# pi-plan-mode

A plan mode for [pi](https://pi.dev). Research first, review the plan in a full-screen terminal UI, then approve implementation.

## Install

```sh
pi install npm:@catgirl-systems/pi-plan-mode
```

## Usage

Run `/plan <task>` to create a plan. Add inline comments, review changes between revisions, and approve when ready — in the current session or a fresh one.

Project edits are blocked during planning. Plans are saved in `.pi/plans/`.

- `/plans` — browse saved plans
- `/plan-review [name]` — review a plan
- `/plan start` / `/plan off` — toggle planning mode
- `/plan export [path]` — export the latest plan

## Development

```sh
npm install
npm test
```
