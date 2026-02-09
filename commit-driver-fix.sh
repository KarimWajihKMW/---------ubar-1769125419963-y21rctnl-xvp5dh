#!/bin/bash

# Navigate to workspace
cd /workspaces/---------ubar-1769125419963-y21rctnl-xvp5dh

# Stage the changes
git add server.js profile.html test-driver-profile-api.js test-driver-profile-data.js

# Commit the changes
git commit -m "Fix driver account UI to display real database data

- Updated /api/users/:id endpoint to fetch driver earnings from driver_earnings table
- Added today_trips, today_earnings, total_trips, total_earnings fields to API response for drivers
- Updated profile.html to display driver earnings data in separate cards
- Added visual indicators (gradients and icons) for driver-specific fields
- Made driver earnings fields read-only with lock icons
- Driver earnings data is automatically hidden for non-driver users
- All driver fields now show real-time data from database tables"

# Push to main branch
git push origin main

echo "✅ Changes committed and pushed successfully!"
