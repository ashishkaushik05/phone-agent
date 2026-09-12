package com.hermes.connector;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import android.telephony.SmsMessage;
import android.util.Log;

/**
 * Inbound SMS observer. The connector is a non-default SMS app, but
 * {@code SMS_RECEIVED} is still delivered to any holder of {@code RECEIVE_SMS}.
 * Reassembles multipart parts and hands the whole message to
 * {@link LinkService#deliverInboundSms} for relay as {@code sms.inbound}.
 */
public class SmsReceiver extends BroadcastReceiver {

    private static final String TAG = "HermesLink";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) {
            return;
        }
        SmsMessage[] parts = Telephony.Sms.Intents.getMessagesFromIntent(intent);
        if (parts == null || parts.length == 0) {
            return;
        }
        StringBuilder body = new StringBuilder();
        for (SmsMessage p : parts) {
            if (p != null && p.getMessageBody() != null) {
                body.append(p.getMessageBody());
            }
        }
        String from = parts[0] != null ? parts[0].getOriginatingAddress() : null;
        long ts = parts[0] != null ? parts[0].getTimestampMillis() : System.currentTimeMillis();
        Log.i(TAG, "sms.inbound from=" + from + " len=" + body.length());
        LinkService.deliverInboundSms(ctx, from == null ? "" : from, body.toString(), ts);
    }
}
