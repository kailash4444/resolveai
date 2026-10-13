"""Monotonic public numbers; internal case keys and ownership never change."""
from copy import deepcopy
import re

FORMATS = {'incident': ('INC', 7), 'knowledge': ('KB', 5)}


def valid_number(number, kind):
    prefix, width = FORMATS[kind]
    return bool(re.fullmatch(prefix + r'\d{' + str(width) + '}', number))


def allocate(meta, kind):
    prefix, width = FORMATS[kind]
    value = meta.get(kind, 0) + 1
    if value >= 10 ** width:
        raise ValueError(f'{prefix} number range exhausted.')
    meta[kind] = value
    return f'{prefix}{value:0{width}d}'


def rewrite(value, mapping):
    if not mapping:
        return value
    pattern = re.compile(r'(?<![\w-])(?:' + '|'.join(re.escape(key) for key in sorted(mapping,key=len,reverse=True)) + r')(?![\w-])')
    def visit(item):
        if isinstance(item, str): return pattern.sub(lambda match:mapping[match.group()],item)
        if isinstance(item, list): return [visit(part) for part in item]
        if isinstance(item, dict): return {key:visit(part) for key,part in item.items()}
        return item
    return visit(value)


def assign_case(case, existing, meta):
    number = existing.ticket.id if existing else allocate(meta,'incident')
    if not valid_number(number,'incident'): number = allocate(meta,'incident')
    old = case.ticket.id
    aliases = meta.setdefault('incident_aliases',{})
    if old != number and not valid_number(old,'incident'): aliases[old] = number
    result = type(case).model_validate(rewrite(case.model_dump(mode='json'),{old:number} if old != number else {}))
    result.ticket.id = number
    return result


def assign_article(value, existing, meta):
    from realapp.models import KnowledgeArticle
    number = existing.id if existing else allocate(meta,'knowledge')
    if not valid_number(number,'knowledge'): number = allocate(meta,'knowledge')
    if value.id and value.id != number and not valid_number(value.id,'knowledge'): meta.setdefault('knowledge_aliases',{})[value.id] = number
    return KnowledgeArticle(**value.model_dump(exclude={'id'}),id=number)


def sync_case(target, saved):
    for field in type(target).model_fields:
        setattr(target,field,deepcopy(getattr(saved,field)))
    return deepcopy(saved)


def migrate(cases, articles, meta):
    """Idempotent, chronological conversion; keeps counters above existing numbers."""
    for kind, numbers in [('incident',[case.ticket.id for case in cases]),('knowledge',[a.id for a in articles])]:
        prefix, _ = FORMATS[kind]
        meta[kind] = max([meta.get(kind,0)] + [int(n[len(prefix):]) for n in numbers if valid_number(n,kind)])
    mapping = {}
    for case in sorted(cases,key=lambda c:(c.created_at,c.id)):
        if not valid_number(case.ticket.id,'incident'):
            old=case.ticket.id;case.ticket.id=allocate(meta,'incident');mapping[old]=case.ticket.id
            meta.setdefault('incident_aliases',{})[old]=case.ticket.id
    for article in sorted(articles,key=lambda a:a.id):
        if not valid_number(article.id,'knowledge'):
            old=article.id;article.id=allocate(meta,'knowledge');mapping[old]=article.id
            meta.setdefault('knowledge_aliases',{})[old]=article.id
    aliases = {**meta.get('incident_aliases',{}),**meta.get('knowledge_aliases',{})}
    cases = [type(case).model_validate(rewrite(case.model_dump(mode='json'),aliases)) for case in cases]
    articles = [type(article).model_validate(rewrite(article.model_dump(mode='json'),aliases)) for article in articles]
    return cases, articles, aliases
