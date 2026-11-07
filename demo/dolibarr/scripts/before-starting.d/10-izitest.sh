#!/bin/bash
# Run by the Dolibarr image at every start, as root, once its database is ready.
# Makes the instance the same for a person in Chrome and for a headless run of IziTest.

# The forced user of DOLI_AUTH=forceuser: the admin. conf.php is written again when the
# container is recreated (an upgrade, for one), so this line is added again each time.
if ! grep -q 'dolibarr_auto_user' /var/www/html/conf/conf.php; then
  echo "\$dolibarr_auto_user='${DOLI_ADMIN_LOGIN:-admin}';" >> /var/www/html/conf/conf.php
  echo "IziTest demo: forced user set to ${DOLI_ADMIN_LOGIN:-admin}"
fi

# French for everyone, whatever the browser says: a headless Chrome asks for English. A user's
# own language ("auto" for the admin the image creates) would follow the browser again: removed.
mysql -u "${DOLI_DB_USER}" -p"${DOLI_DB_PASSWORD}" -h "${DOLI_DB_HOST}" -P "${DOLI_DB_HOST_PORT:-3306}" "${DOLI_DB_NAME}" -e "
  DELETE FROM llx_const WHERE name = 'MAIN_LANG_DEFAULT' AND entity = 1;
  INSERT INTO llx_const (name, value, type, visible, note, entity) VALUES ('MAIN_LANG_DEFAULT', 'fr_FR', 'chaine', 0, 'IziTest demo', 1);
  DELETE FROM llx_user_param WHERE param = 'MAIN_LANG_DEFAULT';
  UPDATE llx_user SET lang = NULL;
" && echo "IziTest demo: language fr_FR"
