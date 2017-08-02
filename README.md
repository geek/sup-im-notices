# im-notices

## Usage

```
$ ./bin/im-notices sci-135
To: distlist@domain.tld
Subject: Incident Alert: SCI-123 - Compute nodes on strike

Resolved Incident Notification
Sample Private Cloud
------------------------------
Incident Title: SCI-123 - Compute nodes on strike
Priority: 5 - Low
Incident Description: Several compute nodes have gone on strike!
Current Status:
  Zones are halted across several compute nodes, they are refusing to work.
Root Cause: TBD
Incident Start Time: Mon 31-Jul-2017 17:14:00 UTC
Incident End Time: TBD
Incident Duration: TBD
Incident Status: Open
Issue Type: Compute Infrastructure
Incident Owner: John Doe
Location: US-MIDWEST-1A

Send notification? [Y/n] Y
 ✓  Email: Sent. 250 2.0.0 Ok: queued as AF0C61E3D6
 ✓  JIRA: "Last Internal Notice" field updated.
 ✓  JIRA: Comment added with notice details.
 ✓  Manta: Log uploaded to ~~/stor/im-notices/logs/20170802/1506.23_33cfc1f9-9a3a-e738-f9d0-bae92d13bdcc.log
```
