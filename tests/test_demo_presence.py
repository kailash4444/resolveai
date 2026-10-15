from realapp.calling import TechnicianCreate
from test_calling import service


def test_demo_availability_survives_time_without_faking_routing(service):
    for index in range(1, 21):
        service.create_technician(TechnicianCreate(name=f'Demo {index}',
            username=f'demo.tech.{index:02d}', password='isolated-demo-password'))
    first = service.snapshot()
    assert first['metrics']['demo_available'] == 11
    assert first['metrics']['available'] == 11
    service.clock[0] += 86400
    service.dispatch()
    later = service.snapshot()
    assert later['metrics']['demo_available'] == 11
    assert later['metrics']['available'] == 11
    assert all(t['status'] == 'Offline' and not t['voice_ready'] for t in later['technicians'])
    assert sum(t['demo_available'] for t in later['technicians']) == 11
    # Unattended demo accounts never get a reservation, including desk requests.
    call = service.create_call('Test customer')
    def queue(db):
        db['calls'][call['id']].update(status='Queued', ready_at=service.now()-1, queued_at=service.now()-1)
    service.repository.mutate(queue)
    service.dispatch()
    assert service.get(call['id'])['technician_id'] is None
