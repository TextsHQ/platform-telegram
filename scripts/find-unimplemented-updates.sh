#!/usr/bin/env fish
while read l
  if not fgrep -qr $l src/
    echo $l
  end
end < all-updates.txt
