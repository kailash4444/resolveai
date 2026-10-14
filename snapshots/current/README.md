# ResolveAI application snapshot

This snapshot contains the local application's users, incidents (including activity, comments and ticket QA), calls (including transcripts, events and call QA), knowledge articles and numbering metadata. IDs and ownership relationships are preserved. Most records are the requested synthetic demo dataset; earlier application records are also included.

The current snapshot also includes saved Resolution Debt Radar assessments, issue clusters and engineering follow-ups. Incident Time Machine results stored in incident records are included. Snapshot schema version 2 adds the radar files; the restore command also accepts the older version 1 snapshots. Uploaded media and raw audio are not included in this JSON snapshot.

The export date, record counts and file checksums are in `manifest.json`. These files contain application data and belong in this private repository.

Passwords, password hashes, session tokens, login attempts, API keys, cloud credentials and voice access tokens are excluded. Configuration and credentials must be supplied separately. Raw audio is not part of this database snapshot.

## Restore on a fresh checkout

Before starting the application, run from the repository root:

```powershell
python scripts/snapshot_data.py restore
```

The `data` directory must be empty or absent. The command refuses to overwrite an existing installation. It recreates `data/resolveai.sqlite3` and `data/calling.sqlite3`, preserving all record identifiers and the next incident/KB counters. Every restored account gets a new random password in the ignored local file `data/restored_account_logins.csv`. Keep that file private. Users start offline; unfinished calls become callback requests because live audio cannot be restored.

Configure the application using `.env.real.example`, select SQLite for `DATA_BACKEND` and `CALLING_BACKEND`, configure Google credentials and LiveKit, then use `run-local-real.ps1`. Do not run the demo seeder again to restore these records; they are already included.

To restore elsewhere without touching an existing installation:

```powershell
python scripts/snapshot_data.py restore --data-dir data/restored-copy
```

Point the application's SQLite paths at that directory if you choose to run from it.

## Refresh the snapshot

With calls idle, run:

```powershell
python scripts/snapshot_data.py export
```

Review the JSON changes before committing. The exporter reads the databases without changing current account passwords, sessions or application records.
