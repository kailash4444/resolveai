"""Resolution durability, incident clustering, and explainable debt scoring."""
from collections import defaultdict
from bisect import bisect_left, bisect_right
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import math
import re
from threading import Lock
from uuid import uuid4

from fastapi import HTTPException

from realapp.incident_context import resolution_evidence
from realapp.models import (
    CaseRecord, ClusterIncidentLink, ClusterStatusEvent, EngineeringBrief,
    EngineeringFollowup, IssueCluster, ResolutionAssessment,
)


RECURRENCE_WINDOW = timedelta(days=30)
MIN_LINK_CONFIDENCE = 0.40
# Starting product weights from the brief. A missing signal is omitted and the
# remaining weights are renormalized; effort stays missing until tracked.
WEIGHTS = {
    'recurrence_after_closure': 25,
    'incident_frequency': 20,
    'customer_breadth': 20,
    'temporary_workaround_rate': 15,
    'support_effort': 10,
    'severity': 10,
}
SEVERITY = {'P1': 100, 'P2': 75, 'P3': 45, 'P4': 20}
STOP_WORDS = set('''a about after again all also an and any are as at be been before being but by can cannot could did do does doing during each for from get got had has have he her here hers him his how i if in into is it its just like may me might my no not of on or our out over problem put same she should so some such than that the their them then there these they this those through to too under until up use used using very was we were what when where which while who will with work working would you your unable issue error problem request customer support application service system access cannot account enterprise'''.split())
CODE_RE = re.compile(r'\b(?:0x[a-f0-9]{3,}|(?:err(?:or)?[-_ ]?\d{3,})|\b[a-z]{2,8}-\d{3,})\b', re.I)
ENV_RE = re.compile(r'\b(windows|win|macos|ios|android|linux|chromeos)\s*(?:version|ver|v)?\s*(\d+(?:\.\d+){0,2})\b', re.I)
TOKEN_RE = re.compile(r'[a-z0-9][a-z0-9_.-]{1,}')


def evidence_digest(case: CaseRecord) -> str:
    """Hash only evidence relevant to durability, so unchanged audits are reused."""
    body = {
        'state': case.ticket.state,
        'issue_title': case.issue_title,
        'short_description': case.ticket.short_description,
        'description': case.ticket.description,
        'service': case.ticket.service,
        'priority': case.ticket.priority,
        'attempted_steps': case.attempted_steps,
        'resolution': case.ticket.resolution,
        'transcript': [turn.model_dump(mode='json') for turn in case.transcript],
        'notes': [note.model_dump(mode='json') for note in case.ticket.work_notes],
        'qa': [check.model_dump() for check in case.qa_checks],
    }
    return sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _norm(value: str) -> str:
    return ' '.join(TOKEN_RE.findall((value or '').casefold()))


def _tokens(case: CaseRecord) -> set[str]:
    # Keep issue-specific fields dominant; long transcripts otherwise dilute symptom overlap.
    raw = ' '.join((case.issue_title, case.ticket.short_description,
                    case.ticket.description[:500], case.understanding.summary[:300]))
    tokens = {token for token in TOKEN_RE.findall(raw.casefold())
              if len(token) > 2 and token not in STOP_WORDS}
    codes = {value.casefold() for value in CODE_RE.findall(raw)}
    return tokens | codes


def _service_key(case: CaseRecord) -> str:
    return _norm(case.ticket.service) or 'unspecified'


def _environment_signatures(case: CaseRecord) -> set[str]:
    raw = f'{case.ticket.short_description} {case.ticket.description[:500]} {case.understanding.summary[:300]}'
    return {f'{name.casefold()} {version}' for name, version in ENV_RE.findall(raw)}


def _category_key(case: CaseRecord) -> str:
    return _norm(f'{case.ticket.category} {case.ticket.subcategory}')


def _closed_at(case: CaseRecord) -> datetime | None:
    transitions = [event.changed_at for event in case.state_history if event.to_state == 'Resolved']
    if transitions:
        return max((_aware(value) for value in transitions))
    for note in reversed(case.ticket.work_notes):
        if re.search(r'(?im)^State\s*:\s*Resolved(?:\s|$)', note.text):
            return _aware(note.created_at)
    return None


def _reopens(case: CaseRecord) -> list[dict]:
    events = [{'from_state': event.from_state, 'to_state': event.to_state,
               'changed_at': event.changed_at, 'changed_by': event.changed_by}
              for event in case.state_history
              if event.from_state == 'Resolved' and event.to_state != 'Resolved']
    if events:
        return events
    for note in case.ticket.work_notes:
        match = re.search(r'(?im)^State\s*:\s*(.+?)\s+was\s+Resolved\s*$', note.text)
        if match:
            events.append({'from_state': 'Resolved', 'to_state': match.group(1).strip(),
                           'changed_at': note.created_at, 'changed_by': note.author})
    return events


def _recurred_sources(cases: list[CaseRecord]) -> set[str]:
    reported = sorted(_case_created_key(case) for case in cases)
    result = set()
    for case in cases:
        closed_at = _closed_at(case)
        if not closed_at:
            continue
        closed_at = _aware(closed_at)
        next_index = bisect_right(reported, closed_at)
        if next_index < len(reported) and reported[next_index] <= closed_at + RECURRENCE_WINDOW:
            result.add(case.id)
    return result


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def _case_created_key(case: CaseRecord):
    return _aware(case.created_at)


def _candidate_score(left: set[str], right: set[str], same_service: bool,
                     same_category: bool, left_codes: set[str], right_codes: set[str],
                     left_environment: set[str], right_environment: set[str]) -> float:
    if left_codes and right_codes and left_codes.isdisjoint(right_codes):
        return 0.0
    if left_environment and right_environment and left_environment.isdisjoint(right_environment):
        return 0.0
    shared = left & right
    if len(shared) < (1 if left_codes & right_codes else 2):
        return 0.0
    union = left | right
    jaccard = len(shared) / max(1, len(union))
    containment = len(shared) / max(1, min(len(left), len(right)))
    structured = (0.13 if same_service else 0) + (0.07 if same_category else 0)
    return min(1.0, 0.58 * jaccard + 0.42 * containment + structured)


def _link_groups(cases: list[CaseRecord], saved: dict[str, IssueCluster]) -> list[dict]:
    """Greedy, deterministic clustering with an inverted token index (no all-pairs scan)."""
    ordered = sorted(cases, key=_case_created_key)
    groups: list[dict] = []
    token_groups: dict[tuple[str, str], list[int]] = defaultdict(list)
    review = {(cluster.id, link.case_id): link.review_state
              for cluster in saved.values() for link in cluster.links}

    for case in ordered:
        tokens = _tokens(case)
        codes = {value.casefold() for value in CODE_RE.findall(
            ' '.join((case.issue_title, case.ticket.short_description, case.ticket.description[:500])))}
        environments = _environment_signatures(case)
        service, category = _service_key(case), _category_key(case)
        postings = []
        for token in tokens:
            ids = token_groups.get((service, token))
            if ids:
                postings.append((len(ids), ids))
        candidate_ids: set[int] = set()
        for _, ids in sorted(postings, key=lambda item: item[0])[:8]:
            candidate_ids.update(ids)

        best_index, best_score = None, 0.0
        for index in candidate_ids:
            group = groups[index]
            if review.get((group['id'], case.id)) == 'dismissed':
                continue
            score = _candidate_score(tokens, group['tokens'], service == group['service'],
                                     category == group['category'], codes, group['codes'],
                                     environments, group['environments'])
            if score > best_score:
                best_index, best_score = index, score

        if best_index is None or best_score < MIN_LINK_CONFIDENCE:
            cluster_id = 'RD-' + sha256(case.id.encode()).hexdigest()[:10].upper()
            groups.append({'id': cluster_id, 'seed': case, 'cases': [case], 'tokens': tokens,
                           'anchor_tokens': set(tokens),
                           'codes': codes, 'environments': environments,
                           'service': service, 'category': category,
                           'scores': {case.id: 1.0}})
            best_index = len(groups) - 1
            for token in tokens:
                token_groups[(service, token)].append(best_index)
        else:
            group = groups[best_index]
            group['cases'].append(case)
            group['scores'][case.id] = best_score
            # Index new distinct terms to allow later reports to match evolved symptoms.
            for token in tokens - group['tokens']:
                token_groups[(service, token)].append(best_index)
                group['tokens'].add(token)
            group['codes'].update(codes)
            group['environments'].update(environments)
    return groups


def _recurrence_sources(group: dict, now: datetime) -> tuple[int, int]:
    cases = group['cases']
    created = sorted(_case_created_key(case) for case in cases)
    eligible = repeated = 0
    for source in cases:
        closed_at = _closed_at(source)
        if not closed_at:
            continue
        closed_at = _aware(closed_at)
        if now < closed_at + RECURRENCE_WINDOW:
            continue
        eligible += 1
        next_case = bisect_left(created, closed_at + timedelta(microseconds=1))
        if next_case < len(created) and created[next_case] <= closed_at + RECURRENCE_WINDOW:
            repeated += 1
    return repeated, eligible


def _build_links(group: dict, saved_cluster: IssueCluster | None) -> list[ClusterIncidentLink]:
    cases = group['cases']
    existing = {link.case_id: link for link in saved_cluster.links} if saved_cluster else {}
    anchor = group['seed']
    closures = sorted(((_aware(closed_at), case.ticket.id) for case in cases
                       if (closed_at := _closed_at(case))),
                      key=lambda pair: pair[0])
    closure_times = [value[0] for value in closures]
    links = []
    for case in cases:
        reported_at = _case_created_key(case)
        start = reported_at - RECURRENCE_WINDOW
        first = bisect_left(closure_times, start)
        after = bisect_left(closure_times, reported_at)
        prior_closures = [ticket_id for _, ticket_id in closures[first:after][:3]]
        if case.id == anchor.id:
            kind, reason, confidence = 'anchor', 'Earliest incident in this matching group.', 1.0
        elif prior_closures:
            kind = 'recurrence'
            reason = 'Reported within 30 days after related incident closure: ' + ', '.join(prior_closures[:3])
            confidence = group['scores'].get(case.id, 1.0)
        else:
            kind = 'related'
            shared = sorted(_tokens(case) & group.get('anchor_tokens', group['tokens']))[:6]
            reason = 'Matching service and symptom terms: ' + ', '.join(shared)
            confidence = group['scores'].get(case.id, 1.0)
        old = existing.get(case.id)
        links.append(ClusterIncidentLink(case_id=case.id, ticket_id=case.ticket.id,
            confidence=round(confidence, 3), rationale=reason, link_type=kind,
            review_state=old.review_state if old else 'unreviewed'))
    return links


def _score_group(group: dict, assessments: dict[str, ResolutionAssessment], now: datetime,
                 existing_links: list[ClusterIncidentLink] | None = None,
                 recurrence_context: list[CaseRecord] | None = None) -> dict:
    """Score rates directly; cap frequency/customer breadth with 1-exp(-x/3)."""
    cases = group['cases']
    links = existing_links if existing_links is not None else _build_links(group, None)
    recurrence_count = sum(link.link_type == 'recurrence' for link in links)
    _, eligible_sources = _recurrence_sources({'cases': recurrence_context or cases}, now)
    assessed = [assessments[case.id] for case in cases
                if case.id in assessments and case.ticket.state == 'Resolved']
    temp = sum(item.classification == 'temporary_workaround' for item in assessed)
    customers = {case.customer_id for case in cases if case.customer_id.strip()}
    priorities = [case.ticket.priority for case in cases if case.ticket.priority in SEVERITY]
    # Resolution duration is not equivalent to technician effort; do not infer effort from elapsed time.
    values: dict[str, float | None] = {
        'recurrence_after_closure': (round(recurrence_count / len(cases) * 100, 1)
            if recurrence_count else 0.0 if eligible_sources else None),
        'incident_frequency': round(min(100.0, 100 * (1 - math.exp(-max(0, len(cases) - 1) / 3))), 1),
        'customer_breadth': round(min(100.0, 100 * (1 - math.exp(-len(customers) / 3))), 1) if customers else None,
        'temporary_workaround_rate': round(temp / len(assessed) * 100, 1) if assessed else None,
        'support_effort': None,
        'severity': float(max((SEVERITY[value] for value in priorities), default=0)) if priorities else None,
    }
    available_weight = sum(WEIGHTS[name] for name, value in values.items() if value is not None)
    score = (round(sum(values[name] * weight for name, weight in WEIGHTS.items() if values[name] is not None)
                   / available_weight) if available_weight >= 35 else None)
    band = ('critical' if score >= 80 else 'high' if score >= 60 else
            'moderate' if score >= 30 else 'low') if score is not None else 'insufficient'
    missing = [name.replace('_', ' ') for name, value in values.items() if value is None]
    return {'links': links, 'incident_count': len(cases),
        'customer_count': len(customers) if customers else None,
        'recurrence_count': recurrence_count,
        'recurrence_rate': round(recurrence_count / len(cases), 3)
            if recurrence_count or eligible_sources else None,
        'workaround_count': temp,
        'workaround_rate': round(temp / len(assessed), 3) if assessed else None,
        'score': score, 'band': band, 'components': values,
        'evidence_coverage': round(available_weight / sum(WEIGHTS.values()), 3),
        'missing': missing, 'eligible_closed_cases': eligible_sources,
        'assessed_resolved_cases': len(assessed)}


class ResolutionRadar:
    def __init__(self, store, engine):
        self.store = store
        self.engine = engine
        self._assessment_lock = Lock()
        self._assessments_inflight: set[str] = set()

    def assess(self, case: CaseRecord, force: bool = False) -> ResolutionAssessment:
        with self._assessment_lock:
            if case.id in self._assessments_inflight:
                previous = self.store.get_resolution_assessment(case.id)
                if previous and previous.evidence_digest == evidence_digest(case):
                    return previous
                raise RuntimeError('A resolution assessment for this incident is already running.')
            self._assessments_inflight.add(case.id)
        try:
            return self._assess_once(case, force)
        finally:
            with self._assessment_lock:
                self._assessments_inflight.discard(case.id)

    def _assess_once(self, case: CaseRecord, force: bool) -> ResolutionAssessment:
        if case.ticket.state != 'Resolved':
            raise HTTPException(409, 'Resolution durability can be assessed only after the ticket is resolved.')
        digest = evidence_digest(case)
        old = self.store.get_resolution_assessment(case.id)
        if old and old.evidence_digest == digest and not force:
            return old
        payload = self.engine.assess_resolution(case)
        latest = self.store.get_case(case.id)
        if not latest or evidence_digest(latest) != digest:
            raise RuntimeError('Incident evidence changed during assessment; retry the analysis.')
        evidence = resolution_evidence(case)
        allowed_ids = {case.ticket.id, evidence['resolution']['id']}
        allowed_ids.update(item['id'] for item in evidence['transcript'])
        allowed_ids.update(item['id'] for item in evidence['work_notes'])
        allowed_ids.update(item['id'] for item in evidence['qa_checks'])
        payload.evidence_ids = [item for item in payload.evidence_ids if item in allowed_ids]
        payload.approaches = [item for item in payload.approaches
                              if not item.evidence_id or item.evidence_id in allowed_ids]
        if payload.classification == 'durable_fix' and (
                not payload.verification_evidence.strip()
                or not any(value != case.ticket.id for value in payload.evidence_ids)):
            payload.classification = 'unknown'
            payload.rationale = 'The available evidence does not include a cited verification signal, so durability cannot be established.'
            payload.missing_information = list(dict.fromkeys(
                payload.missing_information + ['Customer confirmation or a follow-up verification signal.']))
        cfg = self.engine.settings
        provider = cfg.llm_provider
        model = cfg.openai_model if provider in {'openai', 'mock'} else cfg.gemini_model
        record = ResolutionAssessment(id=f'ASSESS-{uuid4().hex[:12].upper()}', case_id=case.id,
            evidence_digest=digest, provider=provider, model=model, **payload.model_dump())
        return self.store.save_resolution_assessment(record)

    def _materialize(self, cases: list[CaseRecord],
                     assessments: dict[str, ResolutionAssessment] | None = None) -> list[IssueCluster]:
        saved = {cluster.id: cluster for cluster in self.store.list_radar_clusters()}
        cases_by_id = {case.id: case for case in cases}
        if assessments is None:
            assessments = {assessment.case_id: assessment for assessment in self.store.list_resolution_assessments()
                if assessment.case_id in cases_by_id
                and assessment.evidence_digest == evidence_digest(cases_by_id[assessment.case_id])}
        groups = [group for group in _link_groups(cases, saved)
                  if len(group['cases']) > 1 or group['id'] in saved]
        now = datetime.now(timezone.utc)
        clusters: list[IssueCluster] = []
        for group in groups:
            prior = saved.get(group['id'])
            all_group = {**group}
            metrics = _score_group(all_group, assessments, now)
            seed = group['seed']
            signature = {
                'service': _norm(seed.ticket.service),
                'component': _norm(seed.ticket.subcategory or seed.ticket.category),
                'symptom': _norm(seed.ticket.short_description),
                'error_signature': ', '.join(sorted(group['codes'])) or '',
                'environment': ', '.join(sorted(group['environments'])) or '',
            }
            links = _build_links(group, prior)
            last_analysis = max((assessments[c.id].analyzed_at for c in group['cases'] if c.id in assessments), default=None)
            status = prior.status if prior else 'new'
            history = prior.status_history if prior else [ClusterStatusEvent(status='new', changed_by='System')]
            last_status = _aware(history[-1].changed_at) if history else (prior.updated_at if prior else now)
            reopened_after = any(_aware(event['changed_at']) > last_status
                                 for case in group['cases'] for event in _reopens(case))
            new_report_after = any(_case_created_key(c) > last_status for c in group['cases'])
            if prior and prior.status == 'resolved' and (reopened_after or new_report_after):
                status = 'monitoring'
                history = history + [ClusterStatusEvent(status='monitoring', changed_by='System',
                    note='A related incident appeared after the cluster was marked resolved.')]
            service = seed.ticket.service
            priorities = [case.ticket.priority for case in group['cases'] if case.ticket.priority in SEVERITY]
            cluster = IssueCluster(id=group['id'], signature=signature,
                summary=seed.ticket.short_description or seed.issue_title,
                service=service, priority=max(priorities, key=lambda value: SEVERITY[value]) if priorities else '—',
                status=status, incident_count=metrics['incident_count'], customer_count=metrics['customer_count'],
                recurrence_count=metrics['recurrence_count'], recurrence_rate=metrics['recurrence_rate'],
                workaround_count=metrics['workaround_count'], workaround_rate=metrics['workaround_rate'],
                first_occurrence=min(_case_created_key(c) for c in group['cases']),
                latest_occurrence=max(_case_created_key(c) for c in group['cases']),
                last_analysis_at=last_analysis, debt_score=metrics['score'], score_band=metrics['band'],
                score_components=metrics['components'], evidence_coverage=metrics['evidence_coverage'],
                missing_signals=metrics['missing'], links=links, status_history=history,
                created_at=prior.created_at if prior else now, updated_at=prior.updated_at if prior else now)
            if not prior or cluster.model_dump(exclude={'updated_at'}) != prior.model_dump(exclude={'updated_at'}):
                cluster.updated_at = now
                self.store.save_radar_cluster(cluster)
            else:
                cluster.updated_at = prior.updated_at
            clusters.append(cluster)
        return clusters

    def snapshot(self, *, window: str = '30d', service: str = '', priority: str = '',
                 status: str = '', search: str = '', sort: str = 'debt') -> dict:
        cases = self.store.list_cases()
        cases_by_id = {case.id: case for case in cases}
        assessments = {item.case_id: item for item in self.store.list_resolution_assessments()
                       if item.case_id in cases_by_id
                       and item.evidence_digest == evidence_digest(cases_by_id[item.case_id])}
        clusters = self._materialize(cases, assessments)
        now = datetime.now(timezone.utc)
        days = {'7d': 7, '30d': 30, '90d': 90}.get(window)
        start = now - timedelta(days=days) if days else None
        visible = []
        for cluster in clusters:
            if len(cluster.links) < 2:
                continue
            members = [cases_by_id[link.case_id] for link in cluster.links if link.case_id in cases_by_id]
            in_window = [case for case in members if not start or _case_created_key(case) >= start]
            if not in_window:
                continue
            if service and not any(_norm(case.ticket.service) == _norm(service) for case in in_window):
                continue
            if priority and not any(case.ticket.priority == priority for case in in_window):
                continue
            if status and cluster.status != status:
                continue
            query = search.strip().casefold()
            if query and not any(query in ' '.join((case.ticket.id, case.issue_title, case.ticket.short_description,
                                                    case.ticket.description, case.understanding.summary)).casefold()
                                for case in in_window):
                continue
            group = {'id': cluster.id, 'seed': members[0], 'cases': in_window,
                     'tokens': set().union(*(_tokens(case) for case in in_window)),
                     'anchor_tokens': _tokens(members[0]),
                     'scores': {link.case_id: link.confidence for link in cluster.links},
                     'service': _service_key(in_window[0]), 'category': _category_key(in_window[0]),
                     'codes': set().union(*(set(CODE_RE.findall(case.ticket.description)) for case in in_window))}
            window_ids = {case.id for case in in_window}
            window_links = [link for link in cluster.links if link.case_id in window_ids]
            metric = _score_group(group, assessments, now, existing_links=window_links,
                                  recurrence_context=members)
            clone = cluster.model_copy(deep=True)
            clone.incident_count = metric['incident_count']
            clone.customer_count = metric['customer_count']
            clone.recurrence_count = metric['recurrence_count']
            clone.recurrence_rate = metric['recurrence_rate']
            clone.workaround_count = metric['workaround_count']
            clone.workaround_rate = metric['workaround_rate']
            clone.debt_score, clone.score_band = metric['score'], metric['band']
            clone.score_components, clone.evidence_coverage = metric['components'], metric['evidence_coverage']
            clone.missing_signals = metric['missing']
            period_priorities = [case.ticket.priority for case in in_window if case.ticket.priority in SEVERITY]
            clone.priority = max(period_priorities, key=lambda value: SEVERITY[value]) if period_priorities else '—'
            clone.first_occurrence = min(_case_created_key(case) for case in in_window)
            clone.latest_occurrence = max(_case_created_key(case) for case in in_window)
            clone.last_analysis_at = max((assessments[case.id].analyzed_at for case in in_window
                                          if case.id in assessments), default=None)
            visible.append(clone)

        sorters = {
            'debt': lambda item: (item.debt_score is not None, item.debt_score or -1),
            'recurrence': lambda item: item.recurrence_count,
            'severity': lambda item: SEVERITY.get(item.priority, 0),
            'recent': lambda item: _aware(item.latest_occurrence),
        }
        visible.sort(key=sorters.get(sort, sorters['debt']), reverse=True)
        active = [item for item in visible if item.status not in {'resolved', 'dismissed'}]
        resolved_assessed = [assessment for assessment in assessments.values()
            if assessment.case_id in cases_by_id and cases_by_id[assessment.case_id].ticket.state == 'Resolved'
            and (not start or _case_created_key(cases_by_id[assessment.case_id]) >= start)]
        resolved_in_period = [case for case in cases if case.ticket.state == 'Resolved'
                              and (not start or _case_created_key(case) >= start)]
        pending_assessments = sum(case.id not in assessments for case in resolved_in_period)
        workaround_rate = (round(sum(a.classification == 'temporary_workaround' for a in resolved_assessed)
                                 / len(resolved_assessed), 3) if resolved_assessed else None)
        service_values = sorted({case.ticket.service for case in cases
                                 if not start or _case_created_key(case) >= start})
        return {'window': window, 'filters': {'services': service_values, 'statuses':
                ['new', 'investigating', 'monitoring', 'resolved', 'dismissed']},
            'summary': {'open_systemic_issues': len(active),
                'high_debt_issues': sum(item.debt_score is not None and item.debt_score >= 60 for item in visible),
                'recurring_incidents': sum(item.recurrence_count for item in visible),
                'temporary_workaround_rate': workaround_rate,
                'pending_resolution_assessments': pending_assessments,
                'avoidable_effort': None},
            'clusters': [item.model_dump(mode='json') for item in visible]}

    def detail(self, cluster_id: str) -> dict:
        all_cases = self.store.list_cases()
        cases_by_id = {case.id: case for case in all_cases}
        assessments = {item.case_id: item for item in self.store.list_resolution_assessments()
                       if item.case_id in cases_by_id
                       and item.evidence_digest == evidence_digest(cases_by_id[item.case_id])}
        self._materialize(all_cases, assessments)
        cluster = self.store.get_radar_cluster(cluster_id)
        if not cluster:
            raise HTTPException(404, 'Issue cluster not found.')
        incidents, approach_rows = [], {}
        cases_for_cluster = [cases_by_id[link.case_id] for link in cluster.links if link.case_id in cases_by_id]
        recurred_sources = _recurred_sources(cases_for_cluster)
        for link in cluster.links:
            case = cases_by_id.get(link.case_id)
            if not case:
                continue
            assessment = assessments.get(case.id)
            resolution_time = _closed_at(case)
            excerpts = []
            if case.ticket.resolution.strip():
                excerpts.append({'source': 'Resolution notes', 'id': f'resolution:{case.ticket.id}',
                                 'text': case.ticket.resolution[:700]})
            for turn_index, turn in enumerate(case.transcript[:6]):
                if turn.text.strip():
                    excerpts.append({'source': f'{turn.speaker} transcript', 'id': f'transcript:{turn_index}',
                                     'text': turn.text[:500]})
            for note in case.ticket.work_notes[-5:]:
                if note.text.strip():
                    excerpts.append({'source': f'{note.author_type} note', 'id': f'note:{note.id}',
                                     'text': note.text[:500]})
            incidents.append({'case_id': case.id, 'ticket_id': case.ticket.id,
                'title': case.ticket.short_description, 'service': case.ticket.service,
                'priority': case.ticket.priority, 'state': case.ticket.state,
                'created_at': case.created_at, 'resolved_at': resolution_time,
                'reopens': _reopens(case), 'link': link.model_dump(mode='json'),
                'resolution_classification': assessment.classification if assessment else None,
                'resolution_confidence': assessment.confidence if assessment else None,
                'resolution_rationale': assessment.rationale if assessment else '',
                'resolution_evidence_ids': assessment.evidence_ids if assessment else [],
                'verification_evidence': assessment.verification_evidence if assessment else '',
                'missing_information': assessment.missing_information if assessment else [],
                'evidence': excerpts})
            if assessment:
                for approach in assessment.approaches:
                    key = _norm(approach.approach)[:100]
                    row = approach_rows.setdefault(key, {'approach': approach.approach, 'cases': set(),
                        'recurrences': set(), 'outcomes': []})
                    row['cases'].add(case.ticket.id)
                    if case.id in recurred_sources:
                        row['recurrences'].add(case.ticket.id)
                    if approach.outcome:
                        row['outcomes'].append(approach.outcome)
        incidents.sort(key=lambda item: item['created_at'])
        approaches = []
        for row in approach_rows.values():
            count, repeats = len(row['cases']), len(row['recurrences'])
            if count < 2:
                outcome = 'Observed in one incident; no comparison is available.'
            elif repeats:
                outcome = f'Cases documenting this approach were later followed by recurrence in {repeats} of {count}; this is an observed association, not proof of causation.'
            else:
                outcome = f'No later recurrence is recorded for {count} linked incidents; effectiveness is not established.'
            approaches.append({'approach': row['approach'], 'incident_count': count,
                               'recurrence_count': repeats, 'outcome': outcome,
                               'documented_outcomes': list(dict.fromkeys(row['outcomes']))[:5]})
        recommendations = self._recommendations(cluster, approaches)
        return {'cluster': cluster.model_dump(mode='json'), 'incidents': incidents,
                'resolution_history': approaches, 'recommendations': recommendations,
                'followups': [item.model_dump(mode='json') for item in
                              self.store.list_engineering_followups(cluster_id)]}

    def _recommendations(self, cluster: IssueCluster, approaches: list[dict]) -> list[dict]:
        repeated = [item for item in approaches if item['incident_count'] >= 2 and item['recurrence_count']]
        if repeated:
            item = max(repeated, key=lambda value: value['recurrence_count'])
            return [{'action': f'Review whether teams should stop repeating “{item["approach"]}” as the final fix.',
                     'evidence': item['outcome']}]
        if cluster.incident_count >= 3:
            return [{'action': 'Compare component, version, and environment details across linked cases.',
                     'evidence': f'{cluster.incident_count} incidents share this service and symptom signature; those diagnostic fields are not consistently stored.'},
                    {'action': 'Capture a verification signal after any proposed fix.',
                     'evidence': 'Durability assessments require evidence beyond a ticket being marked Resolved.'}]
        return [{'action': 'Collect component/version details and verify the reported outcome after the fix.',
                 'evidence': f'{cluster.incident_count} related incident records are available; common cause is not established.'}]

    def change_status(self, cluster_id: str, status: str, user: str, note: str = '') -> IssueCluster:
        allowed = {'new', 'investigating', 'monitoring', 'resolved', 'dismissed'}
        if status not in allowed:
            raise HTTPException(422, 'Select a supported investigation status.')
        current = self.store.get_radar_cluster(cluster_id)
        if not current:
            self._materialize(self.store.list_cases())
            current = self.store.get_radar_cluster(cluster_id)
        if not current:
            raise HTTPException(404, 'Issue cluster not found.')
        if current.status != status:
            current.status = status
            current.updated_at = datetime.now(timezone.utc)
            current.status_history.append(ClusterStatusEvent(status=status, changed_by=user,
                note=note.strip()[:400]))
            self.store.save_radar_cluster(current)
        return current

    def review_link(self, cluster_id: str, case_id: str, decision: str) -> IssueCluster:
        if decision not in {'confirmed', 'dismissed', 'unreviewed'}:
            raise HTTPException(422, 'Choose confirmed, dismissed, or unreviewed.')
        current = self.store.get_radar_cluster(cluster_id)
        if not current:
            raise HTTPException(404, 'Issue cluster not found.')
        link = next((item for item in current.links if item.case_id == case_id), None)
        if not link:
            raise HTTPException(404, 'Incident link not found.')
        if link.link_type == 'anchor' and decision == 'dismissed':
            raise HTTPException(409, 'Dismiss the cluster from its investigation status instead of dismissing its anchor incident.')
        link.review_state = decision
        current.updated_at = datetime.now(timezone.utc)
        self.store.save_radar_cluster(current)
        return current

    def generate_followup(self, cluster_id: str, user: str) -> EngineeringFollowup:
        detail = self.detail(cluster_id)
        cluster = self.store.get_radar_cluster(cluster_id)
        cases_by_id = {case.id: case for case in self.store.list_cases()}
        assessments = {item.case_id: item for item in self.store.list_resolution_assessments()
                       if item.case_id in cases_by_id
                       and item.evidence_digest == evidence_digest(cases_by_id[item.case_id])}
        numeric = {'incident_count': cluster.incident_count,
                   'distinct_customers': cluster.customer_count,
                   'recurrence_count': cluster.recurrence_count,
                   'recurrence_rate': cluster.recurrence_rate,
                   'temporary_workaround_count': cluster.workaround_count,
                   'temporary_workaround_rate': cluster.workaround_rate,
                   'debt_score': cluster.debt_score,
                   'score_evidence_coverage': cluster.evidence_coverage}
        source_cases = [cases_by_id.get(link.case_id) for link in cluster.links]
        sources = []
        approaches = []
        source_cases_for_brief = [case for case in source_cases if case]
        selected_sources = (source_cases_for_brief if len(source_cases_for_brief) <= 30 else
                            source_cases_for_brief[:15] + source_cases_for_brief[-15:])
        for case in selected_sources:
            if not case:
                continue
            assessment = assessments.get(case.id)
            transcript = ' '.join(turn.text for turn in case.transcript if turn.speaker.casefold() == 'customer')[:500]
            work_notes = [{'id': f'note:{note.id}', 'author_type': note.author_type,
                           'text': note.text[:500]} for note in case.ticket.work_notes[-5:]
                          if note.author_type in {'Technician', 'Customer'}]
            sources.append({'ticket_id': case.ticket.id, 'title': case.ticket.short_description,
                'state': case.ticket.state, 'service': case.ticket.service,
                'priority': case.ticket.priority, 'resolution': case.ticket.resolution[:700],
                'customer_excerpt': transcript, 'work_notes': work_notes,
                'durability': assessment.classification if assessment else 'not assessed',
                'qa_findings': [{'field': check.field, 'result': check.result,
                                 'evidence': check.evidence[:300]} for check in case.qa_checks
                                if check.result != 'PASS'],
                'approaches': [item.model_dump() for item in assessment.approaches] if assessment else []})
            if assessment:
                approaches.extend(f"{case.ticket.id}: {item.approach} — {item.outcome}"
                                  for item in assessment.approaches)
        evidence = {'cluster': {'id': cluster.id, 'summary': cluster.summary,
                    'signature': cluster.signature, 'status': cluster.status,
                    'score_components': cluster.score_components, 'missing_signals': cluster.missing_signals},
                    'calculated_metrics': numeric, 'sources': sources,
                    'resolution_history': detail['resolution_history'],
                    'omitted_source_count': max(0, len(source_cases_for_brief) - len(sources))}
        generated = self.engine.draft_engineering_brief(json.dumps(evidence, ensure_ascii=False))
        impact = (f"{cluster.incident_count} linked incidents for {cluster.service}; highest recorded priority "
                  f"{cluster.priority}. First seen {_aware(cluster.first_occurrence).isoformat()}, most recent "
                  f"{_aware(cluster.latest_occurrence).isoformat()}. {cluster.recurrence_count} recurrence(s) "
                  'were recorded within 30 days after closure.')
        if cluster.customer_count is not None:
            impact += f" {cluster.customer_count} distinct customer accounts are identified."
        else:
            impact += ' A reliable distinct-customer count is unavailable.'
        if cluster.workaround_rate is not None:
            impact += f" {cluster.workaround_count} of {sum(1 for c in source_cases if c and c.ticket.state == 'Resolved' and c.id in assessments)} analyzed resolved incidents were classified as temporary workarounds."
        else:
            impact += ' Temporary-workaround rate is unavailable because resolved outcomes have not been assessed.'
        snippets = []
        for source in sources:
            if source['resolution']:
                snippets.append(f"{source['ticket_id']} resolution: {source['resolution']}")
            elif source['customer_excerpt']:
                snippets.append(f"{source['ticket_id']} customer: {source['customer_excerpt']}")
            snippets.extend(f"{source['ticket_id']} {note['author_type']} note: {note['text']}"
                            for note in source['work_notes'])
            snippets.extend(f"{source['ticket_id']} QA {item['field']} ({item['result']}): {item['evidence']}"
                            for item in source['qa_findings'])
        title = (cluster.summary or 'Recurring support issue')[:180]
        brief = EngineeringBrief(title=title, customer_impact=impact,
            evidence=snippets[:30], what_has_been_tried=list(dict.fromkeys(approaches))[:30],
            source_ticket_ids=[case.ticket.id for case in source_cases if case],
            **generated.model_dump())
        followup = EngineeringFollowup(id=f'ENG-{uuid4().hex[:10].upper()}', cluster_id=cluster_id,
            brief=brief, created_by=user)
        return self.store.save_engineering_followup(followup)
