"""Seed 16 curated synthetic incidents for the Incident Time Machine demo.

The default mode is a read-only preview. Import is idempotent, adds cases only,
and assigns them to accounts that already exist in the configured calling store.
"""
import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from realapp.calling_store import create_calling_store
from realapp.config import Settings
from realapp.incident_time_machine import compare_history, reconstruct
from realapp.models import (CaseRecord, RoutingDecision, Ticket, TicketStateTransition,
                            TranscriptTurn, Understanding, WorkNote)
from realapp.store import create_store


DATASET = 'time-machine-showcase-v1'
_CASES = [
    dict(title='Payroll export totals mismatch after month-end', service='Payroll', category='Business application', subcategory='Payroll export', priority='P2',
         opening='The month-end payroll export is short by 42 contractor rows. The approval deadline is today, so I have paused the bank upload.',
         question='Does the mismatch affect every pay group, and which export run produced this file?',
         context='Only contractors hired in the last two weeks are missing. The preview has the right count, but the downloaded CSV does not.',
         failed='Re-running the same export with the default date range did not work; the CSV still omits the 42 recent hires.',
         signal='The export audit shows the preview used the local payroll cutoff, while the background job used UTC midnight.',
         handoff='I reviewed the transcript and the failed rerun. The preview and download came from different cutoff paths; I will not ask you to rerun it again yet.',
         action='I compared the run IDs and aligned the background job cutoff to the approved payroll timezone, then generated a test export only.',
         outcome='The test export now includes all 42 contractor rows. I checked the count against the preview before releasing it for approval.',
         resolution='Corrected the payroll export cutoff after matching the preview and job run IDs; customer verified the contractor count before upload.',
         validation='I verified the export works and contains all 42 rows. The payroll manager approved it before the bank upload.',
         attempts=['Reran the default month-end export; the same 42 contractor rows were missing.', 'Compared the preview count with the downloaded CSV.'],
         reopened=True),
    dict(title='Payroll export totals mismatch after month-end close', service='Payroll', category='Business application', subcategory='Payroll export', priority='P2',
         opening='The month-end payroll export total is higher than the approved payroll register by 18,400 rupees.',
         question='Is the difference in the row count, the gross-pay total, or both? Please do not upload the file while we compare it.',
         context='The row count matches. The export has a second adjustment line for employees transferred between cost centers.',
         failed='Removing the second adjustment line in a copied spreadsheet did not work; the total still differs from the signed register.',
         signal='The register uses the transfer effective date, but this export groups the adjustment by the processing date.',
         handoff='The row count is correct and the spreadsheet edit was only a copy. I am taking over to check the adjustment rule against the signed register.',
         action='I traced one transferred employee through the adjustment ledger and compared effective-date and processing-date totals with Payroll Operations.',
         outcome='Payroll Operations confirmed the processing-date adjustment is expected for this close. I documented the 18,400 rupee difference and left the upload blocked for their sign-off.',
         resolution='', validation='I have the reconciliation attached, but Payroll Operations has not approved the total yet.',
         attempts=['Compared the export row count with the signed payroll register.', 'Edited a copy of the export to isolate the duplicate adjustment.'],
         state='In Progress', hold_reason=''),
    dict(title='Payroll export totals mismatch for contractor adjustments', service='Payroll', category='Business application', subcategory='Payroll export', priority='P2',
         opening='The month-end payroll export still has a contractor adjustment that Finance has not approved.',
         question='Can you share the run ID and the approval reference, without uploading the file to the bank?',
         context='The export run is PX-8821. Finance approval is pending because the cost-center transfer is backdated.',
         failed='Generating another export did not work; it produced the same unapproved adjustment and would not resolve the approval dependency.',
         signal='The adjustment is tied to a backdated transfer request that is still awaiting Finance approval.',
         handoff='The export engine is behaving consistently with its input. I am keeping the upload paused while Finance owns the approval decision.',
         action='I linked run PX-8821 to the Finance approval task and set a follow-up for the approver; no payroll values were changed.',
         outcome='The incident is On Hold for Finance approval. The approved register and export remain unchanged.',
         resolution='', validation='I can see the approval task and will wait before uploading the file.',
         attempts=['Confirmed the export run ID and compared the pending adjustment with the approval task.'],
         state='On Hold', hold_reason='Waiting for Finance approval; no unapproved payroll change was applied.'),
    dict(title='Citrix session black screen after sign-in', service='Virtual Desktop', category='Software', subcategory='Virtual desktop', priority='P2',
         opening='My Citrix session turns black immediately after sign-in, and I have a customer demonstration in 30 minutes.',
         question='Does the session remain black if you reconnect once, and are other users in your office affected?',
         context='Reconnect gives the same black screen. My teammate can sign in from the same office, so I saved the session ID.',
         failed='Resetting the display preference did not work; the same session ID still opens to a black screen.',
         signal='The session broker shows my profile container mounted read-only after last night’s profile policy change.',
         handoff='I checked the session ID and the first technician’s display reset. The broker record points to a profile mount problem, not a monitor issue.',
         action='I asked the EUC team to detach the stale profile mount through the approved console, then started a fresh session without deleting profile data.',
         outcome='The fresh session loaded the desktop. We opened the presentation and confirmed the user files were present.',
         resolution='EUC safely detached a stale read-only profile mount and validated a fresh Citrix session with the user.',
         validation='I verified the desktop and presentation are working, and my files are present. The demonstration is ready.',
         attempts=['Reconnected the Citrix session once.', 'Reset the display preference; the same session stayed black.']),
    dict(title='Citrix session black screen after policy refresh', service='Virtual Desktop', category='Software', subcategory='Virtual desktop', priority='P2',
         opening='Citrix opens to a black screen after sign-in for three members of our finance team.',
         question='Do all three sessions show the same error, and did anything change in the desktop policy today?',
         context='All three sessions are black. A policy refresh ran this morning, but other departments can still sign in.',
         failed='Restarting one virtual desktop did not work; the black screen returned after the next sign-in.',
         signal='The three affected sessions landed on host VDI-17; the broker has no failures for sessions on other hosts.',
         handoff='The issue follows one host rather than each user profile. I will keep the other sessions untouched and ask EUC to drain VDI-17 for inspection.',
         action='EUC drained VDI-17 from new assignments, captured its broker and graphics logs, and moved the three sessions to healthy hosts.',
         outcome='The finance users reached their desktops on the alternate hosts. VDI-17 remains isolated while EUC reviews the policy refresh.',
         resolution='Moved affected sessions to healthy hosts and isolated VDI-17 for investigation; this is a service-restoring workaround, not a confirmed host fix.',
         validation='All three users can work again. We understand the original host is still under investigation.',
         attempts=['Restarted one virtual desktop; the black screen returned at the next sign-in.']),
    dict(title='Citrix session black screen pending profile approval', service='Virtual Desktop', category='Software', subcategory='Virtual desktop', priority='P3',
         opening='A new employee gets a black Citrix screen after sign-in, but the session log shows the profile was not provisioned.',
         question='Is this the employee’s first virtual desktop session, and has their manager approved the required profile group?',
         context='It is their first session. The profile group request is waiting for the manager’s approval.',
         failed='Retrying the sign-in did not work; the profile is not provisioned until the access request is approved.',
         signal='The access audit shows the profile group request is still pending with the employee’s manager.',
         handoff='This is an access dependency rather than a failed desktop. I have confirmed the request owner and will not keep restarting the session.',
         action='I linked the incident to the profile-group approval request and told the employee how to check its status.',
         outcome='The case is On Hold pending manager approval; no access group was added without approval.',
         resolution='', validation='I can see who needs to approve it. I will try Citrix after the request is complete.',
         attempts=['Retried the Citrix sign-in once; the profile remained unprovisioned.'],
         state='On Hold', hold_reason='Pending manager approval for the employee profile group.'),
    dict(title='Citrix session black screen after sign-in on VDI-17', service='Virtual Desktop', category='Software', subcategory='Virtual desktop', priority='P2',
         opening='Two users see a black Citrix screen after sign-in on VDI-17, while their sessions work on the other hosts.',
         question='Can the users sign in on another host, and are their profile containers mounted read-write?',
         context='Both users sign in on VDI-12. Their profiles are read-write there; only new sessions on VDI-17 go black.',
         failed='Resetting one affected profile did not work; the next VDI-17 session still opened to a black screen.',
         signal='Broker traces show VDI-17 assigning the stale graphics profile to new sessions; the two healthy-host tests preserved user data.',
         handoff='The other incident’s profile-mount fix is relevant evidence, but these users already have read-write profiles on healthy hosts. I will compare the VDI-17 broker trace before touching profiles.',
         action='EUC drained VDI-17, corrected its graphics-profile assignment through the approved change, then admitted one test session before restoring capacity.',
         outcome='The test session opened normally on VDI-17 and retained the user profile. Both users confirmed their applications were available.',
         resolution='Corrected the stale graphics-profile assignment on VDI-17 after comparing broker traces and verified a clean test session.',
         validation='I confirmed Citrix is working on VDI-17 and my applications and files are available.',
         attempts=['Reset one affected profile; the next VDI-17 session remained black.', 'Verified the same users could sign in on VDI-12.']),
    dict(title='VPN connection drops after sign-in on office Wi-Fi', service='Remote Access', category='Network', subcategory='VPN', priority='P2',
         opening='My VPN drops every few minutes when I connect from office Wi-Fi, interrupting a remote database migration.',
         question='Does the drop happen on wired Ethernet as well, and can you note the VPN disconnect time?',
         context='Wired Ethernet stays connected. The Wi-Fi drops line up with a roam between access points on floor four.',
         failed='Reinstalling the VPN client did not work; the disconnect happened again during the next Wi-Fi roam.',
         signal='The VPN logs show a new tunnel negotiation when the laptop changes access points; the wired test has no tunnel reset.',
         handoff='The reinstall did not change the symptom. The timestamps line up with Wi-Fi roaming, so I am checking the network path before touching VPN policy.',
         action='Network Operations adjusted the affected access-point roaming profile in the approved change window and captured a before-and-after tunnel trace.',
         outcome='The VPN stayed connected during three access-point roams and the migration session remained active.',
         resolution='Network Operations corrected the access-point roaming profile and verified stable VPN tunnels across three roams.',
         validation='I verified the VPN stayed connected while I walked the same route; the migration worked and the indicator did not reset.',
         attempts=['Reinstalled the VPN client; the tunnel still dropped during Wi-Fi roaming.', 'Confirmed wired Ethernet remained stable.']),
    dict(title='VPN connection drops after sign-in during home broadband use', service='Remote Access', category='Network', subcategory='VPN', priority='P3',
         opening='The VPN disconnects at home every 10 to 15 minutes, although video calls continue without interruption.',
         question='Does the tunnel drop on a mobile hotspot too, and what time did the last disconnect occur?',
         context='A mobile hotspot stayed connected for an hour. Home broadband drops align with a router lease renewal.',
         failed='Changing the laptop Wi-Fi network did not work; the VPN still dropped at the broadband lease renewal.',
         signal='The client log shows the public IP changed at the same time as the router renewal.',
         handoff='The hotspot test separates the laptop from the home broadband path. I am preserving the client logs and checking the router lease behavior.',
         action='I documented the lease-renewal timestamps and asked Network Operations to review the broadband path; the customer can use the verified hotspot workaround meanwhile.',
         outcome='The case remains In Progress while Network Operations checks the home broadband trace. No VPN policy change has been made.',
         resolution='', validation='The hotspot works for now. I will keep the ticket open until the home broadband path is checked.',
         attempts=['Changed the laptop Wi-Fi network; the tunnel still dropped at the broadband lease renewal.', 'Used a mobile hotspot for a one-hour comparison.'],
         state='In Progress'),
    dict(title='Teams meeting one-way audio after dock firmware update', service='Collaboration', category='Software', subcategory='Meeting audio', priority='P2',
         opening='People can hear me in Teams, but I cannot hear them after my USB-C dock firmware updated overnight.',
         question='Does audio work through the laptop speakers when the dock is disconnected?',
         context='Laptop speakers work. The Teams output device changes to the dock after reconnecting it.',
         failed='Reinstalling Teams did not work; the output switched back to the dock and remote audio disappeared.',
         signal='The device trace shows Teams retaining the old dock endpoint ID after firmware changed the endpoint name.',
         handoff='The first reinstall did not address the endpoint selection. I will compare the current device ID with the saved Teams output setting.',
         action='I selected the newly named dock endpoint in Teams, placed a short test call, and confirmed the device remained selected after reconnecting the dock.',
         outcome='Two-way audio worked in the test call and stayed selected after a dock reconnect.',
         resolution='Selected the new dock audio endpoint in Teams and validated two-way audio across a reconnect.',
         validation='I confirmed Teams audio is working both ways, and the output stayed on the dock after I reconnected it.',
         attempts=['Reinstalled Teams; one-way audio returned after reconnecting the dock.']),
    dict(title='Teams meeting one-way audio after headset change', service='Collaboration', category='Software', subcategory='Meeting audio', priority='P3',
         opening='I can hear the Teams meeting but nobody can hear me through my new headset.',
         question='Does the headset microphone appear in the operating-system input meter outside Teams?',
         context='The input meter moves. Teams is still using the laptop microphone, which is muted by the meeting-room setup.',
         failed='Restarting Teams did not work; the application reopened with the laptop microphone still selected.',
         signal='The headset is available and unmuted at the system level; only the Teams input selection is wrong.',
         handoff='The system input test passed. I will correct Teams’ selected microphone rather than changing permissions or reinstalling the client.',
         action='I selected the headset microphone in Teams, unmuted it in the meeting, and asked a colleague to confirm the test-call audio.',
         outcome='The colleague confirmed clear audio from the headset; the system privacy settings were left unchanged.',
         resolution='Selected and validated the headset microphone in Teams; no system-wide privacy changes were needed.',
         validation='I confirmed the headset audio is working; my colleague can hear me clearly in the meeting now.',
         attempts=['Restarted Teams; the laptop microphone remained selected.']),
    dict(title='Label printer creates duplicate shipping labels after driver rollout', service='Printing', category='Hardware', subcategory='Label printer', priority='P2',
         opening='The warehouse label printer produces two shipping labels for each order since the approved driver rollout.',
         question='Are the duplicate labels identical, and does the duplicate happen from one workstation or every workstation?',
         context='The labels are identical and every packing station is affected. Staff have stopped reprinting orders to avoid duplicate shipments.',
         failed='Clearing one workstation queue did not work; a fresh order still produced two labels at every station.',
         signal='The print server audit shows the new driver submitted each job once, but the device firmware acknowledged each job twice.',
         handoff='The duplicate is fleet-wide and the server submitted one job. I am keeping reprints paused while Print Operations verifies the device firmware behavior.',
         action='Print Operations restored the previously approved device profile during the change window and tested with a non-shipping sample label.',
         outcome='One sample label printed exactly once at three stations. Warehouse staff resumed shipping after verifying the queue count.',
         resolution='Restored the approved label-printer profile and verified single output on three packing stations.',
         validation='I verified the printer is working and the test order produced one label at each station. We checked the first live order.',
         attempts=['Cleared one workstation queue; the device still printed two copies.', 'Paused order reprints while duplicate shipping risk was assessed.']),
    dict(title='Label printer creates duplicate shipping labels after queue recovery', service='Printing', category='Hardware', subcategory='Label printer', priority='P2',
         opening='Shipping labels are duplicating after the print queue recovers from a brief network interruption.',
         question='Does a single test job duplicate only after a network interruption, or on every print?',
         context='Normal jobs print once. A job submitted during the interruption appears twice in the device history afterward.',
         failed='Restarting the printer did not work; the queued job was replayed twice after the device reconnected.',
         signal='The queue recovery record contains the same job ID twice, while the driver and firmware versions match the prior approved baseline.',
         handoff='This case differs from the recent driver-rollout duplicates: here a single job is replayed after a network interruption. I will preserve the job IDs for comparison.',
         action='Print Operations disabled automatic replay for the affected queue under the approved change and used a unique non-shipping test job to verify recovery.',
         outcome='The test job printed once after reconnect. The incident remains In Progress while the team monitors the next scheduled recovery.',
         resolution='', validation='The test label printed once. Please leave the ticket open until the next scheduled queue recovery is observed.',
         attempts=['Restarted the printer; the device replayed the queued job twice after reconnect.'],
         state='In Progress'),
    dict(title='Database query latency spikes after connection pool deployment', service='Data Platform', category='Database', subcategory='Connection pool', priority='P1',
         opening='Customer checkout queries are timing out across two regions after this morning’s connection-pool deployment.',
         question='Did the timeout rate change immediately after the deployment, and are reads or writes affected?',
         context='The alert began six minutes after deployment. Reads are slow in both regions; the database is healthy and writes are queuing.',
         failed='Increasing the pool size in one region did not work; queue depth increased and the second region was unaffected by that test.',
         signal='The deployment changed the pool from per-worker to shared, but the connection cap remained set per worker.',
         handoff='The one-region pool increase made queueing worse, so I will not repeat it. The cap was interpreted per worker before and after the deployment.',
         action='The database on-call rolled back the connection-pool deployment under the incident change procedure and watched queue depth in both regions.',
         outcome='Queue depth returned to baseline and checkout latency fell below the alert threshold in both regions. The pool change is blocked pending a corrected cap calculation.',
         resolution='Rolled back the connection-pool deployment; verified checkout latency and queue depth in both regions. Corrected rollout remains pending.',
         validation='I verified checkout is working in both regions. The incident commander confirmed the rollback and follow-up owner.',
         attempts=['Raised the pool size in one region; queue depth increased, so the change was reverted.']),
    dict(title='MFA approval prompts rejected after phone migration', service='Identity', category='Access', subcategory='MFA', priority='P2',
         opening='MFA approval prompts are rejected on my replacement phone, and I cannot access the payroll approval portal.',
         question='Was the old phone removed through the approved identity process, and is the new device enrolled in the account portal?',
         context='The new device is enrolled, but the old authenticator registration still appears active. I have not shared any codes.',
         failed='Repeatedly approving the prompt did not work; the old registration still receives the request and the new phone shows a denial.',
         signal='Identity logs show two active device registrations and a pending secure removal request for the old phone.',
         handoff='The prompt is being routed to the old device. I will keep the account protected and wait for the identity team to approve removal.',
         action='I linked the secure device-removal request to the incident and set an identity-team follow-up; no MFA factor was bypassed.',
         outcome='The case is On Hold pending secure removal of the old device. The payroll portal remains inaccessible until the factor change is approved.',
         resolution='', validation='I understand the approval step is still pending. I will not approve unexpected prompts.',
         attempts=['Retried the MFA approval; the new device was still denied.'],
         state='On Hold', hold_reason='Waiting for identity-team approval to remove the old MFA registration.'),
    dict(title='API gateway latency after traffic shift', service='Production API', category='Infrastructure', subcategory='Gateway', priority='P1',
         opening='The API gateway latency alert just fired after a traffic shift. We have not confirmed customer impact yet.',
         question='Which regions and routes are in the alert, and do the traces show elevated upstream time or gateway time?',
         context='Only the canary region is alerting. The first traces are still loading and we do not yet know whether requests are failing.',
         failed='No configuration change has been made yet; the current record contains an alert but not enough evidence to identify a cause.',
         signal='Initial monitoring shows a latency increase on the canary route; error rate and customer impact are not yet established.',
         handoff='I am taking the new incident with the canary scope and alert timestamp. We do not have enough evidence to label this a customer outage.',
         action='I am capturing route-level traces and comparing the canary with the prior traffic window before recommending a rollback.',
         outcome='The incident remains New pending the first trace comparison. No rollback or customer-impact claim has been recorded.',
         resolution='', validation='The on-call has the alert and will update the case after the trace comparison.',
         attempts=[], state='New', hold_reason=''),
]


def build_showcase_cases(technicians, customers, reference_time=None):
    """Build stable synthetic cases linked to current technician/customer IDs."""
    technicians = sorted(technicians, key=lambda item: item['id'])
    customers = sorted(customers, key=lambda item: item['id'])
    if len(technicians) < 2 or not customers:
        raise ValueError('At least two existing technicians and one existing customer account are required for handoff examples.')
    now = reference_time or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    cases = []
    for index, plan in enumerate(_CASES):
        case_key = f"showcase-tm-{index + 1:02d}"
        started = now - timedelta(days=(len(_CASES) - index) * 2)
        customer = customers[index % len(customers)]
        primary = technicians[index % len(technicians)]
        specialist = technicians[(index + 1) % len(technicians)]
        state = plan.get('state', 'Resolved')
        current_owner = primary if state == 'New' else specialist
        a, b = primary['name'], current_owner['name']
        p = plan
        ticket_id = f"TM-DEMO-{index + 1:02d}"

        def at(minutes):
            return started + timedelta(minutes=minutes)

        def turn(speaker, name, text, minutes):
            return TranscriptTurn(speaker=speaker, speaker_name=name, text=text,
                                  timestamp=at(minutes).isoformat())

        transcript = [
            turn('Customer', customer['name'], p['opening'], 0),
            turn('Technician', a, p['question'], 3),
            turn('Customer', customer['name'], p['context'], 7),
        ]
        if state != 'New':
            transcript.extend([
                turn('Technician', a, p['failed'], 18),
                turn('Customer', customer['name'], p['signal'], 25),
            ])
            if b != a:
                transcript.append(turn('Technician', b, p['handoff'], 40))
            transcript.extend([
                turn('Technician', b, p['action'], 55),
                turn('Customer', customer['name'], p['outcome'], 72),
            ])
            if p.get('reopened'):
                transcript.extend([
                    turn('Customer', customer['name'], 'The symptom returned on the next scheduled run; the earlier verification did not cover this boundary condition.', 1500),
                    turn('Technician', b, 'I reopened the case, linked the recurrence to the original run IDs, and am checking the missing boundary condition before another close.', 1520),
                    turn('Customer', customer['name'], p['validation'], 1600),
                ])
            elif state == 'On Hold':
                transcript.append(turn('Technician', b, p['hold_reason'], 78))
            elif state == 'In Progress':
                transcript.append(turn('Technician', b, 'The investigation remains open; I have recorded the next owner and the evidence needed to continue.', 78))
            else:
                transcript.append(turn('Technician', b, p['validation'], 88))

        history = []
        if state != 'New':
            history.append(TicketStateTransition(from_state='New', to_state='In Progress',
                changed_at=at(5), changed_by=a))
        if p.get('reopened'):
            history.extend([
                TicketStateTransition(from_state='In Progress', to_state='Resolved', changed_at=at(90), changed_by=a),
                TicketStateTransition(from_state='Resolved', to_state='In Progress', changed_at=at(1490), changed_by=customer['name']),
                TicketStateTransition(from_state='In Progress', to_state='Resolved', changed_at=at(1620), changed_by=b),
            ])
        elif state == 'On Hold':
            history.append(TicketStateTransition(from_state='In Progress', to_state='On Hold',
                changed_at=at(75), changed_by=b))
        elif state == 'Resolved':
            history.append(TicketStateTransition(from_state='In Progress', to_state='Resolved',
                changed_at=at(90), changed_by=b))

        notes = [WorkNote(id=f'{case_key}-ASSIGN', author='Ticket history', author_type='System',
            text=f'Assigned to : {a} was Empty', created_at=at(2))]
        if state != 'New':
            notes.extend([
                WorkNote(id=f'{case_key}-TRIAGE', author=a, author_type='Technician',
                    text=f"Initial triage: {p['question']} {p['context']}", created_at=at(10)),
                WorkNote(id=f'{case_key}-FAILED', author=a, author_type='Technician',
                    text=p['failed'], created_at=at(20)),
            ])
            if b != a:
                notes.append(WorkNote(id=f'{case_key}-HANDOFF', author='Ticket history', author_type='System',
                    text=f'Assigned to : {b} was {a}', created_at=at(38)))
            notes.extend([
                WorkNote(id=f'{case_key}-EVIDENCE', author=b, author_type='Technician',
                    text=f"Handoff review: {p['handoff']} Evidence: {p['signal']}", created_at=at(48)),
                WorkNote(id=f'{case_key}-ACTION', author=b, author_type='Technician',
                    text=f"Action and result: {p['action']} {p['outcome']}", created_at=at(68)),
            ])
            if p.get('reopened'):
                notes.extend([
                    WorkNote(id=f'{case_key}-RETURN', author=customer['name'], author_type='Customer',
                        text='The symptom returned on the next scheduled run; the earlier verification did not cover this boundary condition.', created_at=at(1500)),
                    WorkNote(id=f'{case_key}-RECHECK', author=b, author_type='Technician',
                        text='Reopened and compared the recurrence with the original job IDs; corrected the boundary condition and requested customer verification.', created_at=at(1570)),
                ])
            if state == 'On Hold':
                notes.append(WorkNote(id=f'{case_key}-WAIT', author=b, author_type='Technician',
                    text=p['hold_reason'], created_at=at(74)))
            if state == 'Resolved':
                notes.append(WorkNote(id=f'{case_key}-CONFIRMED', author=customer['name'], author_type='Customer',
                    text=p['validation'], created_at=at(89 if not p.get('reopened') else 1610)))

        title = p['title']
        resolution = p['resolution']
        ticket = Ticket(id=ticket_id, short_description=title,
            description=(f"SYNTHETIC SHOWCASE CASE — {p['opening']}\n\n"
                         'Later troubleshooting, handoffs, and outcomes are recorded in the dated transcript and work notes.'),
            category=p['category'], subcategory=p['subcategory'], service=p['service'],
            priority=p['priority'], assignment_group='Service Desk', assigned_to=b,
            assigned_user_id=current_owner['id'], state=state, resolution=resolution,
            work_notes=notes)
        cases.append(CaseRecord(id=case_key, demo_dataset=DATASET, customer_id=customer['id'],
            created_by=customer['id'], created_at=started, caller=customer['name'],
            channel='Synthetic showcase', transcript=transcript, issue_title=title,
            status='Closed' if state == 'Resolved' else 'Open',
            handler_label='Synthetic technician investigation',
            understanding=Understanding(summary=p['opening'], intent=p['subcategory'],
                product=p['service'], urgency='Critical' if p['priority'] == 'P1' else 'High' if p['priority'] == 'P2' else 'Medium',
                sentiment='Concerned', entities=[p['service'], p['subcategory']]),
            routing=RoutingDecision(handler='Human', confidence=1, risk='High' if p['priority'] in {'P1','P2'} else 'Medium',
                rationale='Curated synthetic handoff scenario; this routing record is demo data, not a live model result.'),
            knowledge_matches=[], next_question=p['question'],
            recommended_action=p['action'] if state != 'New' else p['question'],
            ticket=ticket, qa_checks=[], attempted_steps=p['attempts'], state_history=history))
    return cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--firestore', action='store_true', help='target the configured Firestore project and collection')
    parser.add_argument('--project', help='Google Cloud project (required with --firestore unless configured in environment)')
    parser.add_argument('--collection', help='cases collection (defaults to FIRESTORE_COLLECTION)')
    parser.add_argument('--apply', action='store_true', help='write missing synthetic incidents; default is read-only preview')
    args = parser.parse_args()

    settings = Settings()
    if args.firestore:
        settings.data_backend = settings.calling_backend = 'firestore'
        settings.google_cloud_project = args.project or settings.google_cloud_project
    if args.project:
        settings.google_cloud_project = args.project
    if args.collection:
        settings.firestore_collection = args.collection
    if settings.data_backend == 'firestore' and not settings.google_cloud_project:
        raise SystemExit('Set GOOGLE_CLOUD_PROJECT or pass --project before using Firestore.')
    if args.apply and settings.data_backend != 'firestore':
        raise SystemExit('Refusing to write outside Firestore. Re-run with --firestore and the intended --project.')

    store = create_store(settings)
    accounts_store = create_calling_store(settings)
    accounts = accounts_store.mutate(lambda data: list(data['technicians'].values()), call_ids=())
    technicians = [item for item in accounts if item.get('role') == 'technician']
    demo_technicians = [item for item in technicians if item.get('username', '').startswith('demo.tech.')]
    technicians = demo_technicians if len(demo_technicians) >= 2 else technicians
    customers = [item for item in accounts if item.get('role') == 'customer'
                 and item.get('username', '').startswith('demo.customer.')]
    cases = build_showcase_cases(technicians, customers)
    missing, existing = [], []
    for case in cases:
        (existing if store.get_case(case.id) else missing).append(case)

    target = (f"Firestore project={settings.google_cloud_project}, collection={settings.firestore_collection}"
              if settings.data_backend == 'firestore'
              else f"{settings.data_backend} / {settings.local_data_path}")
    print(f"Target: {target}")
    print(f"Accounts reused: {len(technicians)} existing technicians, {len(customers)} existing customers; no accounts will be created.")
    missing_ids = {case.id for case in missing}
    for case in cases:
        timeline = reconstruct(case)
        related = compare_history(case, cases)['comparable_count']
        mark = 'already present' if case.id not in missing_ids else 'would add'
        print(f"{mark:15} {case.id} · {case.ticket.state:11} · {len(timeline['events']):2} events · {related:2} comparable · {case.ticket.short_description} · {case.ticket.assigned_to}")
    print(f"Summary: {len(missing)} to add, {len(existing)} already present. Existing cases will not be overwritten.")
    states = {state: sum(case.ticket.state == state for case in cases)
              for state in ('New', 'In Progress', 'On Hold', 'Resolved')}
    print("Ticket states: " + ", ".join(f"{state}={count}" for state, count in states.items()))
    if not args.apply:
        print('Preview only. Add --apply to write missing showcase incidents.')
        return
    added = 0
    saved = []
    for case in missing:
        saved_case = store.save_case(case)
        saved.append((saved_case.ticket.id, saved_case.ticket.short_description))
        added += 1
    print(f"Added {added} incidents in dataset {DATASET}.")
    for ticket_id, title in saved:
        print(f"{ticket_id} · {title}")
    print('Customer and technician account IDs were reused; no existing case was overwritten.')


if __name__ == '__main__':
    main()
