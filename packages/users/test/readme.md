# Starting tests

Run docker file to start activemq container for testing purposes
```
docker build -t spinajs/activemq .
docker run   -p 8161:8161 -p 61614:61614 spinajs/activemq
```
