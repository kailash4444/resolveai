# Incident Time Machine showcase data

`scripts/seed_time_machine_showcase.py` adds 16 curated synthetic incidents to
the configured Firestore case collection. They include transcripts, failed
attempts, technician handoffs, dated work notes, and state transitions. The
examples reuse the existing demo technician and customer accounts; they do not
create accounts or replace existing cases.

## State coverage

- 1 New incident with incomplete evidence
- 3 In Progress investigations
- 3 On Hold incidents waiting on a named dependency
- 9 Resolved incidents, including one reopened and resolved again

The strongest walkthroughs are the Virtual Desktop cases: the same black-screen
symptom has a verified profile fix, a service-restoring workaround with the
host still under investigation, and an unresolved access-approval dependency.
The VPN pair distinguishes office Wi-Fi roaming from a home broadband lease
renewal. The Payroll group shows a recurrence after an apparently successful
close, followed by evidence-led rechecking. These records let Time Machine
compare outcomes and replay evidence without claiming a single fix applies to
every similar symptom.

All records are labeled `time-machine-showcase-v1` and their descriptions mark
them as synthetic. Present them as curated demo scenarios, not as actual
customer incidents or measured production results.

## Run from Cloud Shell

Use the ResolveAI shared-account Cloud Shell in the project that hosts the app.
Confirm the active account before writing:

```bash
gcloud auth list --filter=status:ACTIVE --format='value(account)'
```

Then pull the script and install its runtime dependencies:

```bash
cd ~/resolveai-latest
git pull --ff-only origin main
python3 -m venv /tmp/resolveai-time-machine-showcase
source /tmp/resolveai-time-machine-showcase/bin/activate
pip install -r requirements-real.txt
```

First run the read-only preview. It prints the project, collection, account reuse,
ticket states, comparable counts, and how many records would be added:

```bash
PYTHONPATH=. python scripts/seed_time_machine_showcase.py \
  --firestore \
  --project=project-3b78e0f3-2562-4233-a7f \
  --collection=resolveai_cases
```

If the preview targets the expected project and shows 16 records to add, write
them with the same command plus `--apply`:

```bash
PYTHONPATH=. python scripts/seed_time_machine_showcase.py \
  --firestore \
  --project=project-3b78e0f3-2562-4233-a7f \
  --collection=resolveai_cases \
  --apply
```

The import is repeatable: existing showcase document IDs are skipped, so a
rerun after a partial import adds only the missing records. It never clears the
collection. The app assigns normal `INC...` ticket numbers and prints the
resulting numbers after import. No Cloud Run deployment is needed for this
data-only operation.
