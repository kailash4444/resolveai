from realapp.models import KnowledgeArticle


SEED_ARTICLES = [
    KnowledgeArticle(id="KB-1001", title="Reset an enterprise account password", product="Identity and Access Management", symptoms="A user cannot sign in because a password is forgotten, expired, or rejected.", steps=["Verify the caller with the approved identity check.", "Confirm the account is active and not under a security hold.", "Issue a one-time password reset link.", "Ask the user to set a new password and verify sign-in."], resolution="Password reset completed and sign-in confirmed.", tags=["password", "login", "identity"]),
    KnowledgeArticle(id="KB-1002", title="Unlock a locked enterprise account", product="Identity and Access Management", symptoms="A user receives an account locked or too many attempts message.", steps=["Verify the caller's identity.", "Check the directory lock state and recent failed attempts.", "Unlock the account if no security hold is present.", "Have the user retry and confirm successful sign-in."], resolution="Account unlocked after verification and access restored.", tags=["locked", "account", "login"]),
    KnowledgeArticle(id="KB-2001", title="Diagnose remote access connection failures", product="Remote Access", symptoms="A remote worker cannot establish a secure connection or the connection drops.", steps=["Capture the exact error, device, network, and client version.", "Check service status and the user's entitlement.", "Verify device time, certificate validity, and multi-factor authentication.", "Collect client diagnostics and escalate if the failure persists."], resolution="Remote access restored or diagnostic evidence attached for network escalation.", tags=["remote access", "network", "certificate", "mfa"]),
    KnowledgeArticle(id="KB-3001", title="Triage an enterprise application outage", product="Business Applications", symptoms="Multiple users cannot open or use a business-critical application.", steps=["Confirm scope, affected locations, start time, and business impact.", "Check service health and recent releases.", "Link the ticket to an active incident if one exists.", "Escalate with evidence and impact."], resolution="Incident linked or application team engaged with scope and impact documented.", tags=["outage", "application", "incident", "availability"]),
]


def article_document(article: KnowledgeArticle) -> str:
    return "\n".join([
        f"Title: {article.title}", f"Product: {article.product}",
        f"Symptoms: {article.symptoms}", f"Steps: {' '.join(article.steps)}",
        f"Resolution: {article.resolution}", f"Tags: {', '.join(article.tags)}",
    ])
