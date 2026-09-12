package com.hermes.connector;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * On (LOCKED_)BOOT_COMPLETED, starts {@link LinkService} so the connector
 * reconnects to hermes-core without anyone opening an app. The service is
 * directBootAware, so the LOCKED_BOOT_COMPLETED start works before the user
 * unlocks.
 */
public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "HermesConnector";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)) {
            Log.i(TAG, "BootReceiver: " + action + " -> starting LinkService");
            LinkService.ensureRunning(context);
        }
    }
}
