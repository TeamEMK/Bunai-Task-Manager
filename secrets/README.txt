PUT YOUR SERVICE-ACCOUNT KEY FILE HERE
======================================

Drop the .json key file you downloaded from Google Cloud into THIS folder.
Any of these names is auto-detected (no env var needed):

    credentials.json   credential.json   service-account.json   sa-key.json   key.json

So the final path will look like:  bunai/secrets/credentials.json

That's it — re-zip, upload to Hostinger, redeploy, open IMS.

SECURITY
--------
• Never move this file into the public/ folder.
• Never share this file or paste its contents to anyone (it's a private key).
• Then share BOTH Google Sheets (IMS + Sales) with the service account email
  found inside this file ("client_email"), as Viewer.
