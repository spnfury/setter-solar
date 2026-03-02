

const API_BASE = 'https://noco.skypulserobotics.com/api/v2/tables';
const XC_TOKEN = 'L70wS5W3qRofV_JpCgW_zE3iF6m207-Y02t2-B58';
const LEADS_TABLE = 'mgot1kl4sglenym';

async function main() {
    let allRecords = [];
    let offset = 0;
    const batchSize = 200;

    while (true) {
        const res = await fetch(`${API_BASE}/${LEADS_TABLE}/records?limit=${batchSize}&offset=${offset}`, {
            headers: { 'xc-token': XC_TOKEN }
        });
        const data = await res.json();
        const records = data.list || [];
        allRecords = allRecords.concat(records);
        if (records.length < batchSize || data.pageInfo?.isLastPage !== false) break;
        offset += batchSize;
        if (allRecords.length >= 5000) break;
    }

    console.log(`Total Leads in DB: ${allRecords.length}`);

    const calledStatuses = ['completado', 'contestador', 'voicemail', 'no contesta', 'fallido', 'interesado', 'reintentar'];

    let reasons = {
        eligible: 0,
        no_phone: 0,
        invalid_phone: 0,
        scheduled_or_calling: 0,
        has_fecha_planificada: 0,
        called_status: 0,
        other: 0
    };

    allRecords.forEach(l => {
        const phone = String(l.phone || '').trim();
        const status = (l.status || '').toLowerCase();

        if (!phone) {
            reasons.no_phone++;
            return;
        }
        if (phone === '0' || phone === 'null' || phone.length < 6) {
            reasons.invalid_phone++;
            return;
        }
        if (status === 'programado' || status === 'en proceso' || status === 'llamando...') {
            reasons.scheduled_or_calling++;
            return;
        }
        if (l.fecha_planificada) {
            reasons.has_fecha_planificada++;
            return;
        }
        if (calledStatuses.some(s => status.includes(s))) {
            reasons.called_status++;
            return;
        }

        reasons.eligible++;
    });

    console.log("Eligibility Breakdown:", reasons);
}

main().catch(console.error);
