/**
 * Send an SMS via Twilio REST API.
 *
 * @param {string} to - Recipient phone in E.164 format (+1XXXXXXXXXX)
 * @param {string} body - Message text
 * @param {object} env - Worker env with TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 * @returns {Promise<{success: boolean, sid?: string, error?: string}>}
 */
export async function sendSMS(to, body, env) {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;

    const params = new URLSearchParams();
    params.append('To', to);
    params.append('From', env.TWILIO_PHONE_NUMBER);
    params.append('Body', body);

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
    });

    const data = await response.json();

    if (response.ok) {
        return { success: true, sid: data.sid };
    }
    return { success: false, error: data.message || `HTTP ${response.status}` };
}
