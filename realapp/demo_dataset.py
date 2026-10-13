"""Synthetic, named support conversations for the requested product demonstration.

Import is explicit and repeatable. This module makes no AI calls and never fabricates
QA results. Role labels stay canonical for retrieval and audit logic.
"""
from collections import Counter
from datetime import datetime, timedelta, timezone
import csv
import json
from pathlib import Path
import secrets
from zipfile import ZipFile, ZIP_DEFLATED

from realapp.calling import TechnicianCreate
from realapp.models import CaseRecord, Ticket, TranscriptTurn, Understanding, RoutingDecision, WorkNote

DATASET = 'indian-service-desk-demo-v1'
GREETING = 'Thank you calling service desk, how can I help you today?'
TECHNICIANS = [
    'Arjun Reddy', 'Priya Sharma', 'Rahul Verma', 'Sneha Iyer', 'Vikram Rao',
    'Ananya Nair', 'Karthik Menon', 'Pooja Deshmukh', 'Rohit Patel', 'Divya Krishnan',
    'Siddharth Gupta', 'Meera Joshi', 'Aditya Kulkarni', 'Kavya Srinivasan', 'Nikhil Das',
    'Shreya Banerjee', 'Harish Kumar', 'Aishwarya Shetty', 'Manoj Yadav', 'Lakshmi Narayanan',
]
CUSTOMERS = [
    'Aarav Mehta', 'Ishita Reddy', 'Rohan Kapoor', 'Neha Singh', 'Sanjay Malhotra',
    'Nandini Rao', 'Pranav Nair', 'Swati Kulkarni', 'Deepak Chauhan', 'Tanvi Shah',
    'Suresh Pillai', 'Ritika Jain', 'Varun Bhat', 'Aditi Desai', 'Ganesh Iyer',
    'Madhavi Rao', 'Abhishek Mishra', 'Sakshi Agarwal', 'Chirag Patel', 'Bhavana Menon',
    'Ashwin Raj', 'Keerthi Reddy', 'Yash Sinha', 'Rashmi Pandey', 'Vivek Saxena',
    'Sowmya Krishnan', 'Akash Chatterjee', 'Sonal Bansal', 'Tarun Arora', 'Geetha Nair',
]
EXPECTED_COUNTS = {'AD account login':15, 'Display':10, 'Blue screen / CrowdStrike':12,
    'Printing':13, 'Citrix login':8, 'Kronos':5, 'Dragon microphone':3, 'Gmail':9,
    'Keyboard replacement':1, 'Monitor replacement':1, 'MFA':8}


def scenario(group, subtype, count, service, category, priority, question, response,
             checks, observation, action, result, validation, confirmation, resolution,
             state='Resolved', closure='The checks are successful, so I will resolve the incident.',
             problems=None):
    return dict(group=group, subtype=subtype, count=count, service=service, category=category,
        priority=priority, question=question, response=response, checks=checks,
        observation=observation, action=action, result=result, validation=validation,
        confirmation=confirmation, resolution=resolution, state=state, closure=closure,
        problems=problems or [subtype])


SCENARIOS = [
    scenario('AD account login', 'Account deactivated', 5, 'Active Directory', 'Access', 'P3',
        'What is the exact sign-in message, and when did you last use the account?',
        'It says my account is disabled. My last successful sign-in was last week.',
        'I will verify your identity through our approved process and check the account status. Please do not share a password or verification code.',
        'I have completed the identity check through the approved portal. My manager confirms that I have returned to work.',
        'The directory account is deactivated. I have raised a reactivation request with the identity team and asked your manager for approval.',
        'I have contacted my manager. The account still shows disabled, so I cannot access the workstation yet.',
        'That is expected while approval is pending. Can you confirm your manager received the approval request?',
        'Yes, the request is with my manager. I understand that access has not yet been restored.', '', 'On Hold',
        'I will put this incident On Hold pending manager approval and identity-team reactivation.',
        ['My AD account is deactivated after returning from leave.', 'Windows says my AD account has been disabled.', 'I cannot log in after my contract was extended.', 'My enterprise account was deactivated during a team transfer.', 'My AD login was disabled while I was away.']),
    scenario('AD account login', 'Forgot password', 5, 'Active Directory', 'Access', 'P3',
        'Can you reach the approved password-reset portal, and is another sign-in method already registered?',
        'I can open the reset portal, but I am unsure which account to use. My verification method is registered.',
        'Use your corporate account in the reset portal. Complete verification there; do not read the password or verification code to me.',
        'The portal has verified me and now shows the new-password screen.',
        'Choose a new password that meets the displayed requirements, submit it, and try signing in to the corporate workstation.',
        'The reset completed. I can now sign in to Windows with the new password.',
        'Please lock and unlock the workstation once, then open the employee portal to confirm the same account works.',
        'Both checks worked. I can access the employee portal and unlock the workstation.',
        'Customer completed the approved self-service password reset and confirmed Windows and employee-portal access.',
        problems=['I forgot my AD password and cannot sign in.', 'My saved password no longer works and I cannot remember it.', 'I changed my password yesterday and forgot the new one.', 'I need help using the corporate password-reset portal.', 'I cannot recall the password for my Windows domain account.']),
    scenario('AD account login', 'Wrong username format', 5, 'Active Directory', 'Access', 'P4',
        'What username format are you entering? Please share the format, not your password.',
        'I entered my full name with a space. The sign-in screen says the username is incorrect.',
        'I have checked the account directory. The approved sign-in format for this screen is your corporate email address.',
        'I was using my display name instead of the corporate email address.',
        'Select Other user and enter your corporate email address exactly as shown in the employee portal, then enter the password privately.',
        'Using the corporate email address worked. The workstation is signing me in now.',
        'Please open your home folder and the employee portal to confirm you are in the correct account.',
        'My own home folder and employee portal are accessible. The login issue is fixed.',
        'Corrected the sign-in identifier from a display name to the configured corporate email format; customer verified access.',
        problems=['My AD login fails when I enter my full name.', 'The login screen rejects the username format I am using.', 'I am using my display name and cannot log in.', 'I used my full name on the Windows sign-in screen.', 'I may be entering the wrong format for my AD username.']),
    scenario('Display', 'Monitor power issue', 5, 'Workplace hardware', 'Hardware', 'P3',
        'Is the monitor power indicator lit, and does the workstation itself appear to be running?',
        'The workstation is running, but the monitor indicator is off. The screen is completely black.',
        'Please check the accessible monitor power connector and the switch on the power strip. Do not open the monitor or touch damaged wiring.',
        'The monitor cable is slightly loose at the power strip, and that socket was switched off.',
        'With the equipment switched off, securely reconnect the intact plug, turn on the approved power socket, and press the monitor power button.',
        'The indicator is now on, and I can see the Windows sign-in screen.',
        'Please sign in and confirm that the screen stays on while you open a document.',
        'I opened a document and the display stayed on. I can work normally now.',
        'Restored the monitor power connection and confirmed stable display operation with the customer.',
        problems=['My monitor has no power and the screen is black.', 'The display went off after the desk was moved.', 'My workstation is on but the monitor power light is off.', 'The monitor does not turn on at my desk.', 'I see a black screen with no monitor power indicator.']),
    scenario('Display', 'Display settings', 5, 'Workplace hardware', 'Hardware', 'P4',
        'Does the monitor show a picture, and what is different from your normal display setup?',
        'The monitor works, but the second screen duplicates the laptop. Text also looks larger than usual.',
        'I will check the connected displays and the current arrangement with your permission. Both screens are detected.',
        'The settings show Duplicate selected, and one screen is using a different scale.',
        'Choose Extend these displays, arrange the screens to match the desk, and select the recommended resolution and a comfortable approved scale.',
        'The screens now extend correctly, and the text looks normal again.',
        'Please move a document between the screens and reopen the application that was difficult to use.',
        'The document moves correctly and the application fits the screen. The issue is resolved.',
        'Corrected display mode, arrangement, resolution and scaling; customer verified both screens.',
        problems=['My second monitor mirrors the laptop instead of extending it.', 'The display looks zoomed in after reconnecting the dock.', 'Windows are opening on the wrong screen.', 'The monitor resolution changed and the text is too large.', 'My dual-monitor arrangement is incorrect.']),
    scenario('Blue screen / CrowdStrike', 'CrowdStrike-related boot crash', 4, 'Endpoint security', 'Software', 'P2',
        'When does the blue screen appear, and has the endpoint team reported a security-agent problem for this device?',
        'It appears before I can finish signing in. The endpoint bulletin lists this device in a CrowdStrike sensor incident.',
        'I have matched the device to that endpoint incident record. I will collect the crash reference and contact endpoint security; please do not remove security files yourself.',
        'I have shared the crash reference through the support portal. The device keeps restarting.',
        'The endpoint team will carry out its approved recovery procedure. I have arranged an alternate managed workstation while the device is investigated.',
        'I can use the alternate workstation, but the original device has not been repaired.',
        'Can you confirm that the alternate workstation supports your urgent work and that the original device is available for the endpoint team?',
        'Yes, I can continue on the alternate workstation. The original device is available for investigation.', '', 'On Hold',
        'I will keep this incident On Hold with Endpoint Security. The affected device is not yet restored.',
        ['My computer repeatedly blue-screens during startup after a CrowdStrike sensor change.', 'I cannot reach the sign-in screen after the security-agent update.', 'The workstation restarts into a blue screen before login.', 'My managed laptop is stuck in a blue-screen restart loop linked to the endpoint incident.']),
    scenario('Blue screen / CrowdStrike', 'CrowdStrike sensor repair', 4, 'Endpoint security', 'Software', 'P2',
        'Can you provide the crash time and device ID through the support portal?',
        'The crash started after the scheduled sensor deployment. I have uploaded the device ID and crash reference.',
        'Endpoint Security has confirmed a sensor compatibility problem on this device. They will perform the approved repair under the incident.',
        'The endpoint engineer has joined the approved support session. I have saved the work that can be recovered.',
        'The endpoint engineer has completed the approved sensor repair and checked that protection is healthy. Please restart the workstation once.',
        'The workstation restarted normally and I can sign in. The security status shows healthy.',
        'Please open your usual applications and work for a few minutes while we check for another crash.',
        'The applications are working and there has been no further blue screen during the validation.',
        'Endpoint Security completed an approved sensor repair; customer verified a clean restart and normal application use.',
        problems=['My computer blue-screens after the CrowdStrike sensor update.', 'I get intermittent blue screens following an endpoint-agent deployment.', 'My workstation crashes when the security sensor starts.', 'The new security sensor build is associated with crashes on my laptop.']),
    scenario('Blue screen / CrowdStrike', 'CrowdStrike deployment rollback', 4, 'Endpoint security', 'Software', 'P2',
        'Is this device part of the deployment group named in the endpoint bulletin, and when did the crashes begin?',
        'Yes, it is in that group. The first crash occurred after last night’s approved security-agent deployment.',
        'I have checked the deployment record and linked your device to the endpoint investigation. Endpoint Security will decide the approved remediation.',
        'The endpoint team has confirmed the affected deployment and has authorised a managed rollback for this device.',
        'The endpoint team has rolled the sensor back to its approved version and verified that endpoint protection remains active. Please restart.',
        'The restart completed and the desktop is stable again.',
        'Please open the business application and confirm that the security team sees the device checking in normally.',
        'My application works, and the endpoint engineer confirms a healthy check-in with no repeat crash.',
        'Endpoint Security performed an approved sensor rollback, retained active protection and verified normal startup and application use.',
        problems=['Blue screens started after the latest CrowdStrike rollout.', 'My laptop crashes after the overnight sensor deployment.', 'The endpoint bulletin mentions the same blue-screen symptom I have.', 'I need support for a blue screen linked to the managed security-agent rollout.']),
    scenario('Printing', 'Printer/workstation connection', 6, 'Printing', 'Hardware', 'P3',
        'Which printer are you using, and is the queue showing Offline or a connection error?',
        'The office printer shows Offline on my workstation. The printer itself is powered on.',
        'Please check that the workstation is on the approved office network and that the printer has a working network connection.',
        'My workstation was connected to the guest network after a desk move. It cannot reach the office printer.',
        'Reconnect to the approved corporate network, then refresh the managed printer connection. I will clear only the failed test job with your permission.',
        'The printer now shows Ready and the new test job has reached the queue.',
        'Please print one non-confidential test page and tell me whether it actually reaches the output tray.',
        'The test page printed successfully. My workstation and the printer are connected again.',
        'Restored the workstation’s corporate-network connection and managed printer connection; customer confirmed a physical test print.',
        problems=['I cannot print because my workstation cannot connect to the printer.', 'The printer is online but appears Offline on my laptop.', 'Print jobs remain in the queue after changing networks.', 'My workstation lost its connection to the office printer.', 'I cannot reach the network printer from my new desk.', 'The office printer is unavailable from my workstation.']),
    scenario('Printing', 'Out of toner', 3, 'Printing', 'Hardware', 'P3',
        'Does the printer control panel show a toner warning, and are other users seeing the same issue?',
        'The display says Replace toner. Other users cannot print from this device either.',
        'I will confirm the consumable alert and ask the authorised office support person to replace the cartridge. Please use the approved spare only.',
        'Office support has the correct sealed replacement cartridge and is at the printer.',
        'Office support has replaced the empty cartridge according to the device instructions and the consumable warning has cleared.',
        'The printer is Ready and it has accepted my test print.',
        'Please check the printed page for complete, readable text and confirm that the toner warning is gone.',
        'The page is readable and the warning has cleared. Printing is working again.',
        'Authorised office support replaced the empty toner cartridge; customer verified a readable test page.',
        problems=['The printer is out of toner and will not print.', 'The office printer displays Replace toner.', 'Print jobs stop because the toner cartridge is empty.']),
    scenario('Printing', 'Blank printouts', 4, 'Printing', 'Hardware', 'P3',
        'Are all documents blank, or does it happen only with one application?',
        'My document produces blank pages. A printer test page is readable, so the printer can put text on paper.',
        'That points us to the document or workstation print settings. I will compare the print preview and try a simple non-confidential document.',
        'The preview is blank in the original application, but a simple text document previews correctly.',
        'Reopen the document, correct the selected page range and print-content settings, and use the approved application’s print option.',
        'The preview now includes the document text and the printer has produced a page with the content.',
        'Please check every page of the short test document and confirm that the expected text appears.',
        'All test pages contain the expected text. I am no longer getting blank printouts.',
        'Corrected application print-content and page-range settings after confirming a healthy printer test page; customer verified complete output.',
        problems=['My document prints blank pages.', 'The printer feeds paper but my report has no text on it.', 'I get blank printouts from one application.', 'My PDF print job produces empty pages.']),
    scenario('Citrix login', 'Citrix account deactivated', 4, 'Citrix', 'Access', 'P3',
        'What does the Citrix sign-in page say, and can you still sign in to other corporate services?',
        'Citrix says the account is disabled, but my Windows login still works.',
        'I will complete the approved identity check and compare the Citrix entitlement with the active directory account.',
        'The identity check is complete. My manager says I still need the Citrix application for this role.',
        'Your Citrix access entitlement is deactivated. I have sent the reactivation request to the application owner for approval.',
        'The application owner has received it, but Citrix still blocks my sign-in.',
        'Please confirm that your manager is copied on the approval request and that you have an alternate way to do urgent work.',
        'My manager is copied and has arranged alternate work. Citrix access is still pending.', '', 'On Hold',
        'I will keep the incident On Hold pending the Citrix owner’s access approval.',
        ['My Citrix account has been deactivated.', 'Citrix says my account is disabled although Windows works.', 'I lost Citrix access after moving to another team.', 'The Citrix portal rejects my inactive account.']),
    scenario('Citrix login', 'Browser cache/session', 4, 'Citrix', 'Software', 'P3',
        'Does the login fail in another browser session, and are you using a saved Citrix bookmark?',
        'The bookmark returns to an old sign-in screen repeatedly. A private browser window reaches the current portal.',
        'That suggests stale site data or an old session. Save your work and close the Citrix tabs before changing browser site data.',
        'My work is saved and the Citrix tabs are closed. I can see the browser’s site-data settings.',
        'Clear only the Citrix site’s cached data and cookies, then open the approved current portal URL and sign in privately.',
        'The login loop is gone and I can see my published applications.',
        'Launch one authorised application and confirm that the session stays connected.',
        'The application launched and stayed connected. Citrix login works normally now.',
        'Cleared stale Citrix browser site data, used the current portal URL and verified successful application launch.',
        problems=['Citrix login keeps returning to the sign-in page.', 'My browser shows an old Citrix session and will not let me in.', 'Citrix opens a cached login page that does not work.', 'I cannot log in to Citrix from my usual browser.']),
    scenario('Kronos', 'Time-out stamp missing', 3, 'Kronos', 'Business application', 'P3',
        'Which shift and date are affected, and do you have evidence of the attempted time-out?',
        'Yesterday’s time-out is missing. I have the kiosk confirmation and the scheduled shift details.',
        'I will check the visible attendance record without editing it and attach your evidence to a payroll correction request.',
        'The shift shows my time-in but no time-out. My supervisor can confirm when I left.',
        'I have submitted the missing time-out with the supporting evidence to your supervisor and the timekeeping team for approval.',
        'My supervisor has received the request. The missing stamp has not yet been corrected.',
        'Please confirm the shift date in the request is correct. We will not enter a new time without the authorised approval.',
        'The date and shift are correct. I will wait for the supervisor-approved correction.', '', 'On Hold',
        'I will keep the incident On Hold pending the approved Kronos time-out correction.',
        ['My time-out stamp was not registered in Kronos.', 'Kronos shows no clock-out for yesterday’s shift.', 'The kiosk confirmed my time-out but Kronos did not record it.']),
    scenario('Kronos', 'Time-in stamp missing', 2, 'Kronos', 'Business application', 'P3',
        'Which shift is affected, and did the kiosk or mobile app show a confirmation when you clocked in?',
        'This morning’s time-in is missing even though the kiosk showed a confirmation. I kept the reference.',
        'I will check the attendance record and collect the confirmation reference, without changing your hours.',
        'The record contains no time-in for the shift. My supervisor saw me arrive and can confirm it.',
        'I have raised a time-in correction request with the evidence and routed it to your supervisor and the timekeeping team.',
        'The request is visible to my supervisor. The time-in is still missing until approval.',
        'Please confirm the employee and shift details are correct in the request. The timekeeping team will process the authorised correction.',
        'The details are correct. I understand that my attendance record is not yet changed.', '', 'On Hold',
        'I will keep this incident On Hold pending the approved Kronos time-in correction.',
        ['My time-in stamp is not registered in Kronos.', 'I clocked in at the kiosk but Kronos has no time-in entry.']),
    scenario('Dragon microphone', 'Dictation microphone not detected', 3, 'Dragon dictation', 'Software', 'P3',
        'Does Windows detect the dictation microphone, and is the same device selected in Dragon?',
        'Windows detects the USB dictation microphone, but Dragon is using the laptop microphone profile.',
        'I will check the selected recording source with your permission. Please use a non-confidential phrase for the test.',
        'The USB microphone appears in Windows recording devices and its input meter moves when I speak.',
        'Select the approved dictation microphone in Dragon’s audio source settings, reopen the microphone profile and run its audio check.',
        'Dragon now detects the dictation microphone, and the audio check has completed.',
        'Please dictate a short non-confidential sentence and use one microphone control button to confirm the profile works.',
        'Dragon captured the sentence and the microphone control works. Dictation is available again.',
        'Selected the detected USB dictation microphone in Dragon and verified audio calibration, dictation and device controls.',
        problems=['Dragon cannot detect my dictation microphone.', 'My USB dictation microphone works in Windows but not in Dragon.', 'Dragon says no dictation microphone is selected.']),
    scenario('Gmail', 'Unable to send email', 3, 'Google Workspace', 'Messaging', 'P3',
        'What error appears when you send, and does a message without attachments send successfully?',
        'The message reports that the attachment is too large. A short message without it sends successfully.',
        'The account can send mail; the attachment is the blocker. Please confirm the recipient is authorised to receive the file.',
        'The recipient is authorised, and I can store the file in our approved shared Drive location.',
        'Upload the file to the approved Drive location, grant only the required recipient access, and send its link instead of the large attachment.',
        'The message with the Drive link was sent, and the recipient can open the authorised file.',
        'Please check Sent and ask the recipient to confirm receipt. Make sure the link is not available to everyone.',
        'The message is in Sent, the recipient confirmed it arrived, and access is limited to the intended person.',
        'Used an approved Drive link for an oversized attachment and verified successful delivery with restricted recipient access.',
        problems=['I cannot send an email from Gmail with my report attached.', 'Gmail refuses to send a message with a large attachment.', 'My email will not send when I attach the project file.']),
    scenario('Gmail', 'Inbox looks empty', 3, 'Google Workspace', 'Messaging', 'P3',
        'Are you signed in to the expected account, and do the messages appear under All Mail?',
        'I am in the correct work account. I can find the messages in All Mail, but Inbox looks empty.',
        'I will check the search box, inbox view and active filters with your permission. We will not delete any messages.',
        'A filter is set to skip Inbox for incoming mail from our team. The messages have been archived.',
        'Remove the unintended skip-Inbox rule after confirming its scope, clear the search view, and move the selected work messages back to Inbox.',
        'The messages are back in Inbox, and a new test message also appears there.',
        'Please confirm that the expected messages are visible and that no broad rule is still archiving new mail.',
        'My expected messages are visible, and the test message stayed in Inbox. Nothing was deleted.',
        'Corrected an unintended skip-Inbox filter and restored selected archived messages; verified new-mail visibility.',
        problems=['My Gmail inbox looks empty even though I had messages.', 'I cannot see my work messages in Inbox.', 'Gmail opens an empty Inbox but search finds the emails.']),
    scenario('Gmail', 'Find calendar availability', 3, 'Google Workspace', 'Collaboration', 'P4',
        'Are you scheduling an event in Google Calendar, and do you have permission to see the colleagues’ free/busy information?',
        'I am creating a meeting from my work account. I can see free/busy information but do not know how to compare it.',
        'Open the event in Google Calendar and add the intended guests using their corporate addresses.',
        'The guests are added. I can see the scheduling view but I was checking only my own calendar.',
        'Use Find a time to compare the guests’ permitted free/busy slots, choose a shared free slot and confirm the event time zone.',
        'I found a slot when everyone is free, and the event is using India Standard Time.',
        'Please confirm the guest list and meeting time before sending the invitation. Private event details may remain hidden.',
        'The guest list and time are correct. I sent the invitation and can now check availability myself.',
        'Guided the customer through Google Calendar guest free/busy scheduling and verified the chosen time zone and invitation.',
        problems=['How can I find other people’s availability when scheduling from Gmail?', 'I need to compare my colleagues’ calendar availability.', 'I cannot work out when everyone is free for a Google Calendar meeting.']),
    scenario('Keyboard replacement', 'Damaged keyboard', 1, 'Workplace hardware', 'Hardware', 'P3',
        'Which keys are affected, and does the fault persist when the keyboard is tested on another approved workstation?',
        'Several keys do not respond. Office support tested the keyboard on another workstation and the same keys failed.',
        'That confirms a hardware fault. Do not open the keyboard. I will record the asset details and request a replacement.',
        'I have provided the asset tag through the support portal. A spare keyboard is available for temporary use.',
        'Office support has connected the approved spare and raised the permanent replacement request with asset management.',
        'The spare works, but I have not yet received the permanent replacement.',
        'Please type a short test phrase using the spare and confirm the replacement request has the correct delivery location.',
        'The spare works and the delivery location is correct. I am waiting for the permanent keyboard.', '', 'On Hold',
        'I will keep this incident On Hold until asset management delivers and confirms the replacement.',
        ['My keyboard has several broken keys and needs replacement.']),
    scenario('Monitor replacement', 'Faulty monitor', 1, 'Workplace hardware', 'Hardware', 'P3',
        'Has office support tested the monitor with a known-good cable and another workstation?',
        'Yes. It still flickers with a known-good cable and another workstation, but a spare monitor works at my desk.',
        'The checks isolate the fault to the monitor. Please stop using the faulty unit and leave it for authorised asset support.',
        'I have disconnected the faulty monitor safely, and office support has recorded its asset tag.',
        'I have requested a replacement monitor from asset management and arranged an approved spare for your desk.',
        'The spare display is stable, but the permanent replacement has not arrived.',
        'Please confirm that you can use the spare for work and that the replacement request has the right desk location.',
        'The spare is working and the desk location is correct. I am awaiting the replacement monitor.', '', 'On Hold',
        'I will keep this incident On Hold pending delivery and testing of the permanent replacement.',
        ['My faulty monitor needs replacement after repeated flickering.']),
    scenario('MFA', 'Not receiving codes', 4, 'Identity and MFA', 'Access', 'P3',
        'Which registered method is affected, and is an approved alternate method already available on the account?',
        'The code is not arriving on my registered phone. I still have an approved authenticator method.',
        'Please do not share any code with me. I will confirm the account’s registered methods after the approved identity check.',
        'The identity check is complete. My registered phone has weak mobile coverage, but the authenticator app is available.',
        'Choose the already-registered authenticator method on the genuine company sign-in page and complete the challenge privately.',
        'The authenticator challenge worked and I can access the corporate application.',
        'Please sign out and repeat a test sign-in using the approved method. We are not disabling MFA or changing your phone number.',
        'The second sign-in worked. I can use the approved alternate method while the mobile coverage issue is checked.',
        'Verified identity and guided use of an existing approved authenticator method; customer confirmed two successful MFA sign-ins.',
        problems=['I am not receiving my MFA codes on the registered phone.', 'The MFA text message does not arrive when I sign in.', 'I cannot finish login because my verification code is not being delivered.', 'MFA codes are delayed and I cannot access the application.']),
    scenario('MFA', 'Set up MFA', 4, 'Identity and MFA', 'Access', 'P3',
        'Is this your first MFA enrolment, and can you open the approved corporate security setup page?',
        'This is my first enrolment. I can open the setup page using the onboarding access provided by IT.',
        'I will guide you through the approved setup. Keep enrolment QR codes, backup codes and verification prompts private.',
        'The setup page offers the approved authenticator app. My managed phone is ready.',
        'Install or open the approved authenticator, complete enrolment on the genuine setup page, and store recovery information only as your policy allows.',
        'The setup page says enrolment is complete, and the authenticator entry is visible on my phone.',
        'Please perform a fresh sign-in and respond to the challenge only if it is for the sign-in you just started.',
        'My test sign-in succeeded with the authenticator. I understand how to reject an unexpected prompt.',
        'Customer completed approved MFA enrolment and verified a fresh sign-in without sharing enrolment or recovery secrets.',
        problems=['I need help setting up MFA for my corporate account.', 'I have a new managed phone and need to complete my approved MFA enrolment.', 'I am joining the company and need to enrol the authenticator.', 'How do I finish the corporate MFA setup on my phone?']),
]

DEPARTMENTS = ['Finance', 'Human Resources', 'Operations', 'Procurement', 'Customer Support',
    'Sales', 'Facilities', 'Engineering', 'Quality Assurance', 'Administration']
CITIES = ['Hyderabad', 'Bengaluru', 'Chennai', 'Pune', 'Mumbai', 'Delhi']
IMPACTS = ['this is delaying my morning tasks', 'I need this for today’s team handover',
    'I have a deadline this afternoon', 'I need to complete the current shift’s work',
    'my regular work is interrupted']


def plans():
    result = []
    for item in SCENARIOS:
        for variant in range(item['count']):
            index = len(result)
            result.append(dict(item, index=index, variant=variant,
                call_id=f'CALL-DEMO-{index+1:04d}', case_id=f'CASE-DEMO-{index+1:04d}',
                ticket_id=f'INC-DEMO-{index+1:04d}', technician=TECHNICIANS[index % 20],
                customer=CUSTOMERS[index % 30], department=DEPARTMENTS[index % 10],
                city=CITIES[(index // 5) % 6], device=f'WS-DEMO-{index%30+1:03d}',
                problem=item['problems'][variant % len(item['problems'])],
                impact=IMPACTS[(index // 3) % 5]))
    assert Counter(p['group'] for p in result) == EXPECTED_COUNTS
    return result


def turns_for(plan, started_at):
    p = plan
    lines = [GREETING,
        f"Hello, I am {p['customer']}. {p['problem']} I work in {p['department']} at {p['city']}, and {p['impact']}.",
        f"I am {p['technician']}. {p['question']}",
        p['response'] + f" My workstation reference is {p['device']}.",
        f"Thank you, {p['customer'].split()[0]}. {p['checks']}",
        p['observation'], p['action'], p['result'], p['validation'], p['confirmation'],
        p['closure'] + f" The incident number is {p['ticket_id']} and the call reference is {p['call_id']}. You can follow progress in ResolveAI.",
        ('Thank you, ' + p['technician'].split()[0] + '. I have noted the references and will follow the incident for the remaining work.'
            if p['state'] != 'Resolved' else 'Thank you, ' + p['technician'].split()[0] + '. I have noted the references and confirm that I can continue my work.'),
    ]
    return [TranscriptTurn(speaker='Technician' if i%2 == 0 else 'Customer',
        speaker_name=p['technician'] if i%2 == 0 else p['customer'], text=line,
        timestamp=(started_at + timedelta(seconds=i*27+(i//3)*8)).isoformat())
        for i, line in enumerate(lines)]


def build_case(plan, technician, customer, started_at):
    p = plan
    turns = turns_for(p, started_at)
    description = (f"{p['customer']} ({p['department']}, {p['city']}) reported: {p['problem']}\n"
        f"Affected workstation: {p['device']}. Impact: {p['impact']}.\n"
        f"Observed: {p['response']}\nTroubleshooting: {p['checks']} {p['action']}\n"
        f"Customer validation: {p['confirmation']}")
    ticket = Ticket(id=p['ticket_id'], call_id=p['call_id'], short_description=p['problem'].rstrip('.'),
        description=description, category=p['category'], subcategory=p['subtype'], service=p['service'],
        priority=p['priority'], assignment_group='Endpoint Security' if p['service']=='Endpoint security' else 'Service Desk',
        assigned_to=technician['name'], assigned_user_id=technician['id'], state=p['state'], resolution=p['resolution'])
    initial = ('short_description', 'description', 'category', 'subcategory', 'service', 'priority', 'assignment_group', 'assigned_to')
    ticket.work_notes = [
        WorkNote(id=p['ticket_id']+'-INIT', author='Ticket created', author_type='System', created_at=started_at,
            text='\n'.join(f"{key.replace('_',' ').capitalize()} : {getattr(ticket,key)}" for key in initial)+'\nState : New'),
        WorkNote(id=p['ticket_id']+'-WIP', author='Field changes', author_type='System', created_at=started_at+timedelta(minutes=1), text='State : In Progress was New'),
        WorkNote(id=p['ticket_id']+'-TECH', author=technician['name'], author_type='Technician', created_at=started_at+timedelta(minutes=3), text=p['action']),
        WorkNote(id=p['ticket_id']+'-CUSTOMER', author=customer['name'], author_type='Customer', created_at=started_at+timedelta(minutes=4), text=p['confirmation']),
        WorkNote(id=p['ticket_id']+'-STATE', author='Field changes', author_type='System', created_at=started_at+timedelta(minutes=6),
            text=f"State : {p['state']} was In Progress" + (f"\nResolution : {p['resolution']} was Empty" if p['resolution'] else '')),
    ]
    return CaseRecord(id=p['case_id'], demo_dataset=DATASET, customer_id=customer['id'], created_by=customer['id'],
        created_at=started_at, caller=customer['name'], channel='Demo voice call', transcript=turns,
        issue_title=ticket.short_description, status='Closed' if p['state']=='Resolved' else 'Open',
        handler_label='Human handling', understanding=Understanding(summary=p['problem']+' '+p['confirmation'],
            intent=p['subtype'], product=p['service'], urgency='High' if p['priority']=='P2' else 'Medium',
            sentiment='Concerned' if p['state']!='Resolved' else 'Satisfied', entities=[p['device'],p['city']]),
        routing=RoutingDecision(handler='Human', confidence=1, risk='High' if p['service']=='Endpoint security' else 'Medium',
            rationale='Synthetic demonstration of a technician-handled call; routing was not evaluated by a live model.'),
        knowledge_matches=[], next_question='', recommended_action=p['closure'], ticket=ticket, qa_checks=[])


def import_dataset(service, store, credentials_path=None, reference_time=None):
    """Create missing demo records only; preserve existing accounts and edited tickets."""
    credentials_path = Path(credentials_path) if credentials_path else None
    prior_credentials = []
    if credentials_path and credentials_path.exists():
        with credentials_path.open(encoding='utf-8', newline='') as handle:
            prior_credentials = list(csv.DictReader(handle))
    credentials = {item['username']:item for item in prior_credentials}
    accounts = {u['username']:u for u in service.snapshot()['technicians']}
    created_accounts = 0
    technicians, customers = [], []
    for role, names, target in [('technician',TECHNICIANS,technicians), ('customer',CUSTOMERS,customers)]:
        for index, name in enumerate(names, 1):
            username = f'demo.{"tech" if role=="technician" else "customer"}.{index:02d}'
            account = accounts.get(username)
            if account and (account['role']!=role or account['name']!=name):
                raise ValueError(f'Demo username already belongs to a different account: {username}')
            if not account:
                password = secrets.token_urlsafe(18)
                account = service.create_technician(TechnicianCreate(name=name, username=username, password=password,
                    role=role, skills=['general'], languages=['en']))
                credentials[username] = dict(role=role,name=name,username=username,password=password)
                created_accounts += 1
                # Save immediately so an interrupted import cannot lose new account passwords.
                if credentials_path:
                    credentials_path.parent.mkdir(parents=True,exist_ok=True)
                    with credentials_path.open('w',encoding='utf-8',newline='') as handle:
                        writer=csv.DictWriter(handle,fieldnames=['role','name','username','password'])
                        writer.writeheader(); writer.writerows(credentials.values())
            target.append(account)
    base = reference_time or datetime.now(timezone.utc)
    created_cases, created_calls = 0, 0
    records = []
    for p in plans():
        tech, customer = technicians[p['index']%20], customers[p['index']%30]
        started = base-timedelta(hours=(sum(EXPECTED_COUNTS.values())-p['index'])*6)
        case = store.get_case(p['case_id'])
        if not case:
            case = store.save_case(build_case(p,tech,customer,started))
            created_cases += 1
        records.append(case)
        def add_call(db):
            if p['call_id'] in db['calls']:
                return False
            begin = case.created_at.timestamp()
            db['calls'][p['call_id']] = dict(id=p['call_id'],caller=customer['name'],origin='browser',
                customer_id=customer['id'],provider_sid=None,language='en',status='Completed',
                service=p['service'],priority=p['priority'],summary=case.understanding.summary,
                reason=case.routing.rationale,case_id=case.id,technician_id=tech['id'],technician_name=tech['name'],
                created_at=begin,queued_at=begin+10,connected_at=begin+25,ended_at=begin+360,
                reserved_until=None,transcript=[t.model_dump(mode='json') for t in case.transcript],
                events=[dict(at=case.created_at.isoformat(),text='Synthetic demo conversation imported'),
                    dict(at=(case.created_at+timedelta(minutes=6)).isoformat(),text='Call completed; linked incident available')],
                ai_turns=0,declined={},dispatch_id=None,dispatch_sent=False,last_error='',ready_at=None,
                demo_dataset=DATASET,knowledge_matches=[],knowledge_status='ready')
            return True
        created_calls += service.repository.mutate(add_call)
    return dict(created_accounts=created_accounts,created_incidents=created_cases,created_calls=created_calls,
        technicians=technicians,customers=customers,cases=records)


def export_dataset(result, output_dir):
    output_dir = Path(output_dir)
    folder = output_dir/'ResolveAI_Demo_Transcripts'
    folder.mkdir(parents=True,exist_ok=True)
    roster = [dict(role=user['role'],name=user['name'],username=user['username']) for user in result['technicians']+result['customers']]
    with (folder/'accounts.csv').open('w',encoding='utf-8',newline='') as handle:
        writer=csv.DictWriter(handle,fieldnames=['role','name','username']);writer.writeheader();writer.writerows(roster)
    manifest, combined = [], []
    for p, case in zip(plans(), result['cases']):
        text = (f"Call ID: {p['call_id']}\nIncident: {case.ticket.id}\nIssue: {p['group']} / {p['subtype']}\n"
            f"Technician: {p['technician']}\nCustomer: {p['customer']}\nIncident state: {case.ticket.state}\n"
            'Synthetic demo conversation\n\n' + '\n\n'.join(
                f"[{turn.timestamp}] {turn.speaker} ({turn.speaker_name}): {turn.text}" for turn in case.transcript)+'\n')
        (folder/f"{p['call_id']}.txt").write_text(text,encoding='utf-8')
        combined.append(text)
        manifest.append(dict(call_id=p['call_id'],ticket_id=case.ticket.id,issue=p['group'],subtype=p['subtype'],
            technician=p['technician'],customer=p['customer'],state=case.ticket.state))
    with (folder/'call_index.csv').open('w',encoding='utf-8',newline='') as handle:
        writer=csv.DictWriter(handle,fieldnames=list(manifest[0]));writer.writeheader();writer.writerows(manifest)
    (folder/'incidents.json').write_text(json.dumps([case.model_dump(mode='json') for case in result['cases']],indent=2,ensure_ascii=False),encoding='utf-8')
    overview = ('ResolveAI synthetic demo dataset\n20 technicians | 30 customers | 85 calls and incidents\n\n'
        + '\n'.join(f'{group}: {count}' for group,count in EXPECTED_COUNTS.items())
        + '\n\nUse call_index.csv to find a scenario and its incident. Speaker roles and names are included in every turn.\n'
        + 'Resolved examples have outcome notes; approval and hardware delivery cases remain On Hold.\n'
        + 'QA scores are pending real AI audits. No account passwords are included in this export.\n')
    (folder/'README.txt').write_text(overview,encoding='utf-8')
    (output_dir/'ResolveAI_Demo_Transcripts.txt').write_text(overview+'\n\n'+('\n\n'+'='*80+'\n\n').join(combined),encoding='utf-8')
    with ZipFile(output_dir/'ResolveAI_Demo_Transcripts.zip','w',ZIP_DEFLATED) as archive:
        for path in sorted(folder.iterdir()):
            archive.write(path,Path(folder.name)/path.name)
    return manifest
