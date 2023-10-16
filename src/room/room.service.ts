import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { RtcRole, RtcTokenBuilder } from 'agora-access-token';
import { CreateRoomRequestDto } from './dto/create-room-request.dto';
import { PrismaService } from '../prisma/prisma.service';
import { RoomException } from '../exception/room.exception';
import { UserException } from '../exception/user.exception';
import { UserService } from 'src/user/user.service';
import { CheckoutRoomRequestDto } from './dto/checkout-room.dto';

@Injectable()
export class RoomService {
  constructor(
    private prisma: PrismaService,
    private userService: UserService,
  ) {}

  //썸네일 multer, s3부분이므로 일단 제외
  async createRoom(createRoomRequestDto: CreateRoomRequestDto, userId: number) {
    const { title, maxHeadcount, note, category } = createRoomRequestDto; //직접 가져오는값
    const uuid = uuidv4(); //고유한 문자열 생성
    const user = await this.userService.findUserByUserId(userId);
    if (!user) throw UserException.userNotFound();
    const agoraAppId: string = process.env.AGORA_APP_ID ?? '';
    const agoraToken = this.createTokenWithChannel(agoraAppId, uuid);
    const newRoom = {
      title,
      maxHeadcount,
      note,
      category,
      uuid,
      agoraAppId,
      agoraToken,
      ownerId: userId,
      count: 0,
    };
    // await this.roomRepository.createRoom(newRoom);
    const createdRoom = await this.prisma.room.create({
      data: newRoom,
    });
    const owner = await this.userService.findUserByUserId(userId);
    //룸정보, 룸오너 정보 같이 리턴해주기
    return { createdRoom, owner };
  }

  async getRoomListAll() {
    const findRooms = await this.prisma.room.findMany({
      select: {
        uuid: true,
        title: true,
        category: true,
        agoraAppId: true,
        agoraToken: true,
        ownerId: true,
      },
    });
    return findRooms;
  }
  async getRoomByUUID(uuid: string) {
    const findRoom = await this.prisma.room.findUnique({
      where: { uuid: uuid },
    });
    if (!findRoom) throw RoomException.roomNotFound();
    const userId = findRoom.ownerId;
    const owner = await this.userService.findUserByUserId(userId);
    return { findRoom, owner };
  }

  async joinRoom(uuid: string): Promise<boolean> {
    const findRoom = await this.prisma.room.findUnique({
      where: { uuid: uuid },
    });
    if (!findRoom) throw RoomException.roomNotFound();
    if (findRoom.nowHeadcount === findRoom.maxHeadcount)
      throw RoomException.roomFullError();

    const updateResult = await this.prisma.room.update({
      data: {
        nowHeadcount: {
          increment: 1, // 증가시키려는 값
        },
        count: {
          increment: 1,
        },
      },
      where: { uuid: uuid },
    });

    if (!updateResult) throw RoomException.roomJoinError();
    return true;
  }

  async leaveRoom(uuid: string): Promise<boolean> {
    const findRoom = await this.prisma.room.findUnique({
      where: { uuid: uuid },
    });
    if (!findRoom) throw RoomException.roomNotFound();
    if (findRoom.nowHeadcount < 1) throw RoomException.roomLeaveError();

    const updateResult = await this.prisma.room.update({
      data: {
        nowHeadcount: {
          decrement: 1, // 감소시키려는 값
        },
      },
      where: { uuid: uuid },
    });
    if (!updateResult) throw RoomException.roomLeaveError();
    return true;
  }

  async checkoutRoom(
    checkoutRoomRequestDto: CheckoutRoomRequestDto,
    uuid: string,
    userId: number,
  ) {
    const { checkIn, checkOut, totalHours, historyType } =
      checkoutRoomRequestDto;
    const totalSeconds = this.timeStringToSeconds(totalHours);
    const findRoom = await this.prisma.room.findUnique({
      where: { uuid: uuid },
    });
    const roomId = findRoom.roomId;
    const recordedHistory = await this.prisma.history.create({
      data: {
        checkIn,
        checkOut,
        historyType,
        totalHours: totalSeconds,
        User: {
          connect: {
            userId,
          },
        },
        RoomId: roomId,
      },
    });

    return recordedHistory;
  }

  async deleteRoom(userId: number, uuid: string): Promise<boolean> {
    const user = await this.userService.findUserByUserId(userId);
    if (!user) throw UserException.userNotFound();
    const findRoom = await this.prisma.room.findUnique({
      where: { uuid: uuid },
    });
    if (!findRoom) throw RoomException.roomNotFound();

    if (userId != findRoom.ownerId) throw UserException.userUnauthorized();
    const deleteResult = await this.prisma.room.delete({
      where: { uuid: uuid },
    });
    if (!deleteResult) throw RoomException.roomDeleteError();
    return true;
  }

  async deleteRoomFromSocket(uuid: string): Promise<boolean> {
    const deleteResult = await this.prisma.room.delete({
      where: { uuid: uuid },
    });
    if (!deleteResult) throw RoomException.roomDeleteError();
    return true;
  }
  createTokenWithChannel(appID: string, uuid: string): string {
    const HOUR_TO_SECOND = 3600;
    const appCertificate: string = process.env.AGORA_APP_CERTIFICATE ?? '';
    const expirationTimeInSeconds = HOUR_TO_SECOND * 24;
    const role = RtcRole.PUBLISHER;
    const channel = uuid;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const expirationTimestamp = currentTimestamp + expirationTimeInSeconds;

    return RtcTokenBuilder.buildTokenWithUid(
      appID,
      appCertificate,
      channel,
      0,
      role,
      expirationTimestamp,
    );
    //0는게 원래는 uid 자리인데 저거 그냥 똑같아도 이미 다른거에서 고유한 토큰값 나오니깐 0으로 함
  }

  timeStringToSeconds(timeString: string): number {
    // 시간 문자열을 콜론 (:)을 기준으로 분리
    const timeParts = timeString.split(':');

    // 시, 분 및 초를 정수로 파싱
    const hours = parseInt(timeParts[0], 10);
    const minutes = parseInt(timeParts[1], 10);
    const seconds = parseInt(timeParts[2], 10);

    // 초로 변환
    const totalSeconds = hours * 3600 + minutes * 60 + seconds;

    return totalSeconds;
  }
}
