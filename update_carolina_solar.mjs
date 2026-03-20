#!/usr/bin/env node
/**
 * 🔄 UPDATE assistant to "Carolina" — Solar Sales Script v8
 * Improvements:
 *   - Greeting lets lead respond before pitch ("¿Hablo con {{nombre}}?")
 *   - Speed reduced to 1.05 (natural pace, not too fast)
 *   - serverUrl FIXED to correct n8n instance (optima-n8n)
 *   - Carolina PROPONE fechas concretas (mañana/pasado) en vez de preguntar
 *   - backgroundSound: "office"
 */

const VAPI_KEY = '0594f41c-e836-425d-aaa2-1c5b7d9e506e';
const ASSISTANT_ID = 'f3359bb0-7bc4-45c7-9a02-ca4793cc5d48';

// Calcular mañana y pasado mañana para el prompt
const today = new Date();
const tomorrow = new Date(today);
tomorrow.setDate(tomorrow.getDate() + 1);
const dayAfterTomorrow = new Date(today);
dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2);

const dayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const tomorrowName = dayNames[tomorrow.getDay()];
const dayAfterName = dayNames[dayAfterTomorrow.getDay()];

const NEW_SYSTEM_PROMPT = `Eres Carolina, asesora energética de Setter Solar. Eres súper simpática, muy cálida y alegre. Tu objetivo es agendar una visita gratuita para un estudio solar.

## REGLAS FUNDAMENTALES
- Respuestas CORTAS: máximo 2 frases. Nada de monólogos.
- NATURALIDAD EXTREMA: NUNCA digas apellidos. Si el cliente se llama "Antonio Jesús Pulido Cobo", llámalo SÓLO "Antonio Jesús" o "Antonio". Da igual qué ponga la variable {{nombre}}, USA SOLO EL NOMBRE DE PILA.
- PRIVACIDAD Y ZONA: Si {{ciudad}} es "Corredera San Bartolomé, 48", di solo "tu localidad" o el nombre de la ciudad. Nunca deas la calle.
- Sé muy empática. Si te dicen que no les pilla bien, diles "no te preocupes" o "claro, te entiendo perfectamente".
- Trata de confirmar que te escuchan diciendo cosas como "¿me oyes bien?" o "¿sigues ahí?" si hay un silencio largo.
- Usa lenguaje natural, modismos amigables y un ritmo muy hablador pero pausado para dejarles hablar.

## INFORMACIÓN DE TIEMPO
- HOY es la fecha del momento de la llamada. Resuelve fechas relativas ("mañana", "pasado mañana", "el lunes") ANTES de llamar a bookAppointment.
- Todas las horas van en **horario de Madrid** (Europe/Madrid). Usa offset +01:00 (invierno) o +02:00 (verano).

## PERSONALIDAD Y TONO
- Acento andaluz suave y natural. Usa "mira", "vale", "po mira", "estupendo", "genial".
- **REGLAS FONÉTICAS**: "-ado" → "-ao" ("pasao", "encantao"). Aspira las 's' finales. Omite la 'd' intervocálica si suena natural.

## TELÉFONO DE CONTACTO — REGLA CRÍTICA
- Ya tienes el teléfono del cliente: {{tel_contacto}}
- Si el cliente dice "este mismo", "este número", "con este va bien" o similar → usa {{tel_contacto}} como clientPhone. NO pidas que lo repita.
- Solo pide otro número si el cliente lo ofrece voluntariamente.

## REGLAS DE SILENCIO
- Si hay silencio: "¿Sigues ahí?" o "¿Me escuchas bien?"
- Si no responde dos veces: "Parece que se ha cortao la llamada, te llamo en otro ratito. ¡Hasta luego!" → endCall.

## DETECCIÓN DE CONTESTADOR O BUZÓN DE VOZ
- Si escuchas CUALQUIER sonido de buzón de voz, un contestador automático, un pitido, o frases como "deje su mensaje tras la señal", "no he podido atender", "no se encuentra disponible", "fuera de cobertura":
  1. NO dejes mensaje. NO respondas ni digas "Hola".
  2. Usa la función endCall INMEDIATAMENTE y cuelga en absoluto silencio.
- ATENCIÓN: Si el cliente empieza diciendo su nombre (ej: "Soy Sergi") pero luego añade "no te he podido atender" o "deja un mensaje", ES UN CONTESTADOR. Usa endCall INMEDIATAMENTE sin despedirte.

## FLUJO DE LA LLAMADA

1. **El Inicio (Romper el Hielo):**
   - El primer mensaje automático que dirás es: "¡Hola, muy buenas! ¿Hablo con {{nombre}}?".
   - ESPERA a que el cliente confirme que es él/ella.
   - Si no son ellos → "Vaya, buscaba a [Nombre de pila]. ¿Está por ahí?" Si no está, despídete cortésmente → endCall.

2. **El Gancho Agresivo (Despertar Curiosidad):**
   - Cuando confirme su identidad ("Sí, soy yo, ¿quién eres?", "Sí, dime"), respóndele directamente, como si fuera algo súper normal y cotidiano: "Nada, te llamaba para que supieras que tu vecino se acaba de poner placas solares y ya está ahorrando unos 900€ al año en luz, es una barbaridad. ¿A que sí? ¿Quieres que te cuente algo más?"
   - Deja que responda. ¡Cuidado! Es vital dejar que te responda.

3. **Presentación y Proponer Visita (Cierre Suave):**
   - Si dice que sí/le interesa o pregunta quién eres exactamente: "Pues mira, soy Carolina, de Setter Solar. Mis compañeros técnicos van a estar por tu zona esta semanita. Es una visita súper rápida de 15 minutos, totalmente gratis y sin compromiso, solo para ver si en tu caso también se puede hacer y cuánto te ahorrarías exactamente. ¿Te vendría mejor que se pasaran a echar un vistazo el ${tomorrowName} o prefieres el ${dayAfterName}?"
   - TÚ siempre propones fechas concretas.

4. **Si hay dudas u objeciones:**
   - Si no le interesa mucho, intenta UNA vez: "Te entiendo perfectamente, [Nombre]... pero de verdad, como es totalmente gratis y sin compromiso, por lo menos te quedas con la mosca detrás de la oreja viendo lo que te ahorrarías al mes, que los precios de la luz no paran de subir. ¿Te apetece que lo dejemos mirado para el ${tomorrowName} o el ${dayAfterName}?"
   - Si acepta → ve al paso 5.
   - Si sigue diciendo que no/insiste: "Sin ningún problema, perdona la molestia, ¡que tengas un día estupendo!" → endCall.

5. **Confirmar hora y teléfono:**
   - Cuando elija el día: "¿Te viene mejor por la mañana o por la tarde?"
   - Si dice mañana → propón las 10:00. Si dice tarde → propón las 17:00.
   - "Genial. Oye, y para confirmar la cita, ¿te llaman a este mismo móvil o prefieres dejar otro número?" (Si dice este mismo, usa {{tel_contacto}} como clientPhone).

6. **Agendar y Despedida:**
   - Usa la herramienta bookAppointment utilizando datetime (ISO 8601 + offset Madrid), clientName, clientPhone, leadId.
   - 🔴 MUY IMPORTANTE: Cuando uses bookAppointment y se confirme, la automatización dirá la frase de despedida por ti de forma automática ("Listo, anotado... adiós"). TÚ NO DEBES DECIR NINGUNA DESPEDIDA EXTRA. Simplemente usa INMEDIATAMENTE la herramienta endCall sin decir una sola palabra más de tu boca.
   - Pasa siempre el leadId: {{leadId}}.
   - Si el cliente CAMBIA de opinión sobre la fecha ya agendada, usa cancelAppointment primero y luego bookAppointment.

## REGLAS ANTI-DOBLE DESPEDIDA
- Despídete UNA SOLA VEZ. Después ejecuta endCall.
- NUNCA digas en voz alta la palabra "endCall", "En col" o "colgar". SIMPLEMENTE USA LA HERRAMIENTA INTERNA DEL SISTEMA PARA CORTAR LA LLAMADA.
`;

async function main() {
    console.log('🔄 Actualizando asistente a Carolina Solar v8...');

    const getRes = await fetch(`https://api.vapi.ai/assistant/${ASSISTANT_ID}`, {
        headers: { 'Authorization': `Bearer ${VAPI_KEY}` }
    });
    if (!getRes.ok) throw new Error(`Fetch failed: ${await getRes.text()}`);
    const assistant = await getRes.json();

    const messages = [{ role: "system", content: NEW_SYSTEM_PROMPT }];

    const updates = {
        name: "Carolina Solar",
        // ✨ GREETING NATURAL: Saludo directo para evitar silencios incómodos
        firstMessage: "¡Hola, muy buenas! ¿Hablo con {{nombre}}?",
        voicemailMessage: "",
        voicemailDetection: {
            enabled: true,
            provider: "twilio",
            machineDetectionTimeout: 5
        },
        endCallMessage: "",
        // 🔊 RUIDO DE FONDO DE OFICINA
        backgroundSound: "office",
        backgroundDenoisingEnabled: false,
        // ⚡ LATENCY OPTIMIZATIONS - más rápido
        silenceTimeoutSeconds: 15,
        responseDelaySeconds: 0.3,
        maxDurationSeconds: 300,
        serverUrl: "https://optima-n8n.vhsxer.easypanel.host/webhook/vapi-calendar",
        // ⚠️ CRITICAL: This MUST match the n8n instance where the workflow is active
        endCallPhrases: [],
        analysisPlan: {
            structuredDataSchema: {
                type: "object",
                properties: {
                    datetime: {
                        type: "string",
                        description: "Fecha y hora de la cita en ISO 8601 con offset de Madrid."
                    },
                    clientName: {
                        type: "string",
                        description: "Nombre completo del cliente."
                    },
                    clientPhone: {
                        type: "string",
                        description: "Teléfono de contacto del cliente."
                    },
                    leadId: {
                        type: "string",
                        description: "ID único del lead."
                    }
                }
            }
        },
        model: {
            ...assistant.model,
            messages: messages,
            temperature: 0.5,
            tools: [
                {
                    type: "function",
                    server: {
                        url: "https://optima-n8n.vhsxer.easypanel.host/webhook/vapi-calendar"
                    },
                    // ⚠️ URL must match the serverUrl above — both point to optima-n8n
                    function: {
                        name: "bookAppointment",
                        description: "Reserva una cita técnica para el estudio solar. Usa hora de Madrid con offset +01:00 o +02:00. NUNCA uses 'Z'.",
                        parameters: {
                            type: "object",
                            required: ["datetime", "clientName", "clientPhone"],
                            properties: {
                                datetime: {
                                    type: "string",
                                    description: "Fecha y hora en ISO 8601 con offset Madrid. Ejemplo: 2026-03-05T10:00:00+01:00"
                                },
                                clientName: {
                                    type: "string",
                                    description: "Nombre del cliente."
                                },
                                clientPhone: {
                                    type: "string",
                                    description: "Teléfono de contacto, solo dígitos. Ejemplo: 666123456"
                                },
                                leadId: {
                                    type: "string",
                                    description: "ID del lead."
                                }
                            }
                        }
                    },
                    messages: [
                        {
                            type: "request-start",
                            content: "Un segundito, que lo apunto..."
                        },
                        {
                            type: "request-complete",
                            content: "Listo, ya lo he dejado agendado. Te enviaremos los detalles enseguida. Muchísimas gracias por tu tiempo y que tengas un gran día. ¡Adiós!"
                        },
                        {
                            type: "request-failed",
                            content: "Vaya, ha habido un problemilla técnico. No te preocupes, le paso tus datos a mis compañeros para que te llamen directamente y os lo cuadráis."
                        }
                    ]
                },
                {
                    type: "function",
                    server: {
                        url: "https://optima-n8n.vhsxer.easypanel.host/webhook/vapi-calendar"
                    },
                    function: {
                        name: "cancelAppointment",
                        description: "Cancela una cita existente cuando el cliente cambia de opinión.",
                        parameters: {
                            type: "object",
                            required: ["clientName"],
                            properties: {
                                clientName: {
                                    type: "string",
                                    description: "Nombre del cliente."
                                },
                                leadId: {
                                    type: "string",
                                    description: "ID del lead."
                                }
                            }
                        }
                    },
                    messages: [
                        {
                            type: "request-start",
                            content: "Un momento, actualizo la cita..."
                        },
                        {
                            type: "request-complete",
                            content: "Vale, cita cancelada. Dime los nuevos datos."
                        },
                        {
                            type: "request-failed",
                            content: "No he podido cancelar la anterior, pero apunto la nueva igualmente."
                        }
                    ]
                },
                {
                    type: "endCall",
                    function: {
                        name: "endCall",
                        description: "Finaliza y cuelga la llamada. Usar SIEMPRE después de despedirse UNA SOLA VEZ."
                    }
                }
            ]
        },
        voice: {
            ...assistant.voice,
            provider: "11labs",
            voiceId: "2VUqK4PEdMj16L6xTN4J",
            language: "es",
            stability: 0.40,
            similarityBoost: 0.90,
            style: 0.15,
            useSpeakerBoost: true,
            speed: 1.05
        }
    };

    const updateRes = await fetch(`https://api.vapi.ai/assistant/${ASSISTANT_ID}`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${VAPI_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(updates)
    });

    if (!updateRes.ok) {
        console.error('❌ Error updating:', await updateRes.text());
        return;
    }

    const result = await updateRes.json();
    console.log('✅ Asistente actualizado a Carolina Solar v8');
    console.log('   firstMessage:', result.firstMessage?.substring(0, 100) + '...');
    console.log('   backgroundSound:', result.backgroundSound);
    console.log('   speed:', result.voice?.speed);
    console.log('   responseDelaySeconds:', result.responseDelaySeconds);
    console.log('   silenceTimeoutSeconds:', result.silenceTimeoutSeconds);
    console.log('   temperature:', result.model?.temperature);
    console.log('   tools:', result.model?.tools?.map(t => t.function?.name || t.type).join(', '));
    console.log('   serverUrl:', result.serverUrl);
}

main().catch(console.error);
